import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  adminOf,
  seedTestDomain,
  startHarness,
  type Harness,
} from '../testing/harness.ts';
import { signAssertion, tokenRequestBody } from '../testing/jwt.ts';
import { issueServiceAccount, type ServiceAccountFile } from './accounts.ts';
import { SCOPES } from './scopes.ts';

const ORGUNIT = SCOPES.orgunit[1];
const DEVICE = SCOPES.device[1];

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const account = issueServiceAccount(harness.mock.registry, domain.customerId);
  harness.mock.registry.setGrant(domain.customerId, account.client_id, [
    ORGUNIT,
  ]);
  return { harness, domain, account };
}

const exchange = (harness: Harness, assertion: string) =>
  harness.request({
    host: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenRequestBody(assertion),
  });

test('a granted scope yields a token that tokeninfo describes exactly', async (t) => {
  const { harness, domain, account } = await setup(t);
  const response = await exchange(
    harness,
    signAssertion(account, { scope: ORGUNIT, sub: adminOf(domain) }),
  );
  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.expires_in, 3599);
  assert.match(body.access_token, /^ya29\./);
  const info = await harness.request({
    host: 'oauth2.googleapis.com',
    path: '/tokeninfo',
    method: 'POST',
    headers: { authorization: `Bearer ${body.access_token}` },
  });
  assert.equal(info.status, 200);
  assert.equal(info.json().scope, ORGUNIT);
  assert.equal(info.json().aud, account.client_id);
});

test('an ungranted scope fails with unauthorized_client', async (t) => {
  const { harness, domain, account } = await setup(t);
  const response = await exchange(
    harness,
    signAssertion(account, {
      scope: `${ORGUNIT} ${DEVICE}`,
      sub: adminOf(domain),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(response.json().error, 'unauthorized_client');
});

test('bad assertions fail with invalid_grant', async (t) => {
  const { harness, domain, account } = await setup(t);
  const other = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const forged: ServiceAccountFile = {
    ...account,
    private_key: other.privateKey,
  };
  const now = Date.now();
  const cases: [string, string][] = [
    [
      'wrong key',
      signAssertion(forged, { scope: ORGUNIT, sub: adminOf(domain) }),
    ],
    [
      'unknown issuer',
      signAssertion(
        { ...account, client_email: 'x@y.iam.gserviceaccount.com' },
        { scope: ORGUNIT, sub: adminOf(domain) },
      ),
    ],
    [
      'wrong audience',
      signAssertion(account, {
        scope: ORGUNIT,
        sub: adminOf(domain),
        aud: 'https://example.test',
      }),
    ],
    [
      'expired',
      signAssertion(
        account,
        { scope: ORGUNIT, sub: adminOf(domain) },
        now - 7_200_000,
      ),
    ],
    [
      'too long',
      signAssertion(account, {
        scope: ORGUNIT,
        sub: adminOf(domain),
        exp: Math.floor(now / 1000) + 7200,
      }),
    ],
    [
      'unknown subject',
      signAssertion(account, {
        scope: ORGUNIT,
        sub: `nobody@${domain.spec.primaryDomain}`,
      }),
    ],
    ['garbage', 'not.a.jwt'],
  ];
  for (const [label, assertion] of cases) {
    const response = await exchange(harness, assertion);
    assert.equal(response.status, 400, label);
    assert.equal(response.json().error, 'invalid_grant', label);
  }
});

test('a wrong grant type and a missing scope fail with their own errors', async (t) => {
  const { harness, domain, account } = await setup(t);
  const wrongGrant = await harness.request({
    host: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    body: 'grant_type=client_credentials',
  });
  assert.equal(wrongGrant.json().error, 'unsupported_grant_type');
  const noScope = await exchange(
    harness,
    signAssertion(account, { sub: adminOf(domain) }),
  );
  assert.equal(noScope.json().error, 'invalid_scope');
});

test('tokeninfo rejects an unknown token', async (t) => {
  const { harness } = await setup(t);
  const response = await harness.request({
    host: 'oauth2.googleapis.com',
    path: '/tokeninfo',
    query: { access_token: 'ya29.unknown' },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json().error, 'invalid_token');
});
