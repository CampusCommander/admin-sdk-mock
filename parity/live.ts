import { sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { issueServiceAccount } from '../src/auth/accounts.ts';
import { startHarness } from '../src/testing/harness.ts';
import { signAssertion, tokenRequestBody } from '../src/testing/jwt.ts';
import { compareObservations, redact, type Observation } from './compare.ts';
import {
  PARITY_SCOPES,
  PROBES,
  type RequestInput,
  type Transport,
} from './probes.ts';

const credentialPath = process.env.PARITY_CREDENTIAL;
const subject = process.env.PARITY_SUBJECT;
if (!credentialPath || !subject) {
  console.error(
    'Set PARITY_CREDENTIAL to the credential file path and PARITY_SUBJECT to the delegated administrator.',
  );
  process.exit(2);
}
const key = JSON.parse(readFileSync(credentialPath, 'utf8')) as {
  client_email: string;
  private_key: string;
  private_key_id: string;
  client_id: string;
  project_id: string;
};

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

async function fetchObservation(
  input: RequestInput,
  base: (host: string) => string,
): Promise<Observation> {
  const query = new URLSearchParams(input.query ?? {}).toString();
  const response = await fetch(
    `${base(input.host)}${input.path}${query ? `?${query}` : ''}`,
    {
      method: input.method ?? 'GET',
      headers: {
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        ...input.headers,
      },
      body: input.body,
    },
  );
  return { status: response.status, body: parse(await response.text()) };
}

const google: Transport = {
  async token(scope) {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT', kid: key.private_key_id })}.${encode(
      {
        iss: key.client_email,
        scope,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
        sub: subject,
      },
    )}`;
    const assertion = `${unsigned}.${sign('sha256', Buffer.from(unsigned), key.private_key).toString('base64url')}`;
    return fetchObservation(
      {
        host: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenRequestBody(assertion),
      },
      (host) => `https://${host}`,
    );
  },
  request: (input) => fetchObservation(input, (host) => `https://${host}`),
};

const harness = await startHarness();
const domain = harness.mock.domains.create(
  { tier: 'small', seed: 'parity' },
  Date.now(),
).domain;
const account = issueServiceAccount(harness.mock.registry, domain.customerId);
harness.mock.registry.setGrant(domain.customerId, account.client_id, [
  PARITY_SCOPES.customer,
  PARITY_SCOPES.domain,
  PARITY_SCOPES.orgunit,
]);
const mockSubject = `admin@${domain.spec.primaryDomain}`;
const mock: Transport = {
  async token(scope) {
    const response = await harness.request({
      host: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenRequestBody(
        signAssertion(account, { scope, sub: mockSubject }),
      ),
    });
    return { status: response.status, body: parse(response.text) };
  },
  async request(input) {
    const response = await harness.request(input);
    return { status: response.status, body: parse(response.text) };
  },
};

const escape = (text: string) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
const googleSecrets = [
  key.client_id,
  key.project_id,
  key.private_key_id,
  subject.split('@')[1],
].map(escape);
const mockSecrets = [
  account.client_id,
  account.project_id,
  account.private_key_id,
  domain.spec.primaryDomain,
].map(escape);

const results = [];
try {
  for (const probe of PROBES) {
    const real = redact(await probe.run(google), googleSecrets) as Observation;
    const simulated = redact(await probe.run(mock), mockSecrets) as Observation;
    results.push(compareObservations(probe.name, real, simulated));
  }
} finally {
  await harness.close();
}

const date = new Date().toISOString().slice(0, 10);
const evidence = {
  recordedAt: new Date().toISOString(),
  fixture: 'approved Easton read-only fixture',
  scopes: [PARITY_SCOPES.customer, PARITY_SCOPES.domain, PARITY_SCOPES.orgunit],
  limitations: [
    'Device, user, and telemetry success shapes need their scopes in the Easton delegation grant.',
    'The Easton tenant holds few entities. Shapes cover the fields Google returned for its data.',
  ],
  results,
};
mkdirSync('parity/evidence', { recursive: true });
writeFileSync(
  `parity/evidence/live-${date}.json`,
  `${JSON.stringify(evidence, null, 2)}\n`,
);
for (const result of results)
  console.log(
    `${result.mismatches.length === 0 ? 'match' : 'DIFF '} ${result.probe}${result.mismatches.length ? `: ${result.mismatches.join('; ')}` : ''}`,
  );
process.exit(results.some((result) => result.mismatches.length > 0) ? 1 : 0);
