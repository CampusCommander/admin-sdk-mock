import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { issueServiceAccount } from '../auth/accounts.ts';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { ConfigError, resolveConfig, scopesFor } from '../config/config.ts';
import { createMock } from '../mock.ts';
import { findUser } from '../store/user-lookup.ts';
import { ensureDomain } from './ensure-domains.ts';

const NOW = Date.UTC(2026, 9, 10, 12);
const EMPTY = { tier: 'empty', seed: 'ensure', name: 'Ensure District' };
const PRIMARY = 'ensure-district.test';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-'));
  const mock = createMock({
    dataDir: join(dir, 'data'),
    timing: { scale: 1, delays: false },
  });
  t.after(() => {
    mock.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** Resolve one domain entry the way a configuration file in `dir` would. */
  const entry = (domain: Record<string, unknown>) =>
    resolveConfig({ cwd: dir, file: { domains: [domain] } }).domains[0];
  const writeJson = (name: string, value: unknown) => {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  return { dir, mock, entry, writeJson };
}

function configErrors(work: () => unknown): string[] {
  try {
    work();
  } catch (error) {
    if (error instanceof ConfigError) return error.errors;
    throw error;
  }
  return assert.fail('Expected a ConfigError.');
}

const fixturesWith = (local: string) => ({
  users: [
    {
      primaryEmail: `${local}@${PRIMARY}`,
      givenName: local,
      familyName: 'Fixture',
    },
  ],
});

test('an absent domain is created with merged settings and its faults', (t) => {
  const { mock, entry } = setup(t);
  const ensured = ensureDomain(
    mock,
    entry({
      spec: EMPTY,
      settings: { quota: { perMinute: 100 } },
      faults: [{ kind: 'error-rate', rate: 0.5 }],
    }),
    0,
    { quota: { perMinute: 50, retryAfter: true }, latency: { capMs: 1000 } },
    NOW,
  );
  assert.equal(ensured.action, 'created');
  assert.equal(ensured.primaryDomain, PRIMARY);
  assert.equal(ensured.adminEmail, `admin@${PRIMARY}`);
  assert.deepEqual(ensured.serviceAccounts, []);
  const { settings } = mock.domains.get(ensured.customerId)!.record;
  assert.equal(settings.quota.perMinute, 100);
  assert.equal(settings.quota.retryAfter, true);
  assert.equal(settings.latency.capMs, 1000);
  assert.equal(settings.chromeQuota.perMinute, 2400);
  assert.equal(mock.faults.list(ensured.customerId).length, 1);
});

test('each service account writes a 0600 key file and grants its scopes', (t) => {
  const { mock, entry } = setup(t);
  const scopes = [READ_SCOPES[0]];
  const ensured = ensureDomain(
    mock,
    entry({
      spec: EMPTY,
      serviceAccounts: [
        { out: 'keys/read.json', scopes: 'read' },
        { out: 'keys/one.json', scopes, projectId: 'my-project-1' },
      ],
    }),
    0,
    {},
    NOW,
  );
  assert.equal(ensured.serviceAccounts.length, 2);
  for (const [index, account] of ensured.serviceAccounts.entries()) {
    assert.equal(statSync(account.out).mode & 0o777, 0o600);
    const file = JSON.parse(readFileSync(account.out, 'utf8'));
    assert.equal(file.type, 'service_account');
    assert.equal(file.client_email, account.clientEmail);
    assert.equal(file.client_id, account.clientId);
    assert.match(file.private_key, /BEGIN PRIVATE KEY/);
    assert.equal(file.token_uri, 'https://oauth2.googleapis.com/token');
    const expected = scopesFor(index === 0 ? 'read' : scopes);
    assert.deepEqual(account.scopes, expected);
    assert.deepEqual(
      mock.registry.grant(ensured.customerId, account.clientId),
      expected,
    );
  }
  assert.match(
    ensured.serviceAccounts[1].clientEmail,
    /@my-project-1\.iam\.gserviceaccount\.com$/,
  );
});

test('a second run keeps the domain, reuses the key file, and re-grants the scopes', (t) => {
  const { mock, entry } = setup(t);
  const domain = {
    spec: EMPTY,
    serviceAccounts: [{ out: 'keys/app.json', scopes: 'read' }],
  };
  const first = ensureDomain(mock, entry(domain), 0, {}, NOW);
  const [account] = first.serviceAccounts;
  const bytes = readFileSync(account.out);
  mock.registry.setGrant(first.customerId, account.clientId, []);

  const second = ensureDomain(mock, entry(domain), 0, {}, NOW + 60_000);
  assert.equal(second.action, 'kept');
  assert.equal(mock.domains.get(first.customerId)!.record.seededAt, NOW);
  assert.deepEqual(readFileSync(account.out), bytes);
  assert.equal(second.serviceAccounts[0].clientId, account.clientId);
  assert.deepEqual(
    mock.registry.grant(first.customerId, account.clientId),
    READ_SCOPES,
  );

  const widened = ensureDomain(
    mock,
    entry({
      ...domain,
      serviceAccounts: [{ out: 'keys/app.json', scopes: 'read-write' }],
    }),
    0,
    {},
    NOW + 120_000,
  );
  assert.equal(widened.serviceAccounts[0].clientId, account.clientId);
  assert.deepEqual(readFileSync(account.out), bytes);
  assert.deepEqual(
    mock.registry.grant(first.customerId, account.clientId),
    READ_WRITE_SCOPES,
  );
});

test('keep refuses a changed seed specification or fixtures file', (t) => {
  const { mock, entry, writeJson } = setup(t);
  const fixtures = writeJson('fixtures.json', fixturesWith('ada'));
  ensureDomain(mock, entry({ spec: EMPTY, fixtures }), 0, {}, NOW);
  assert.deepEqual(
    configErrors(() =>
      ensureDomain(
        mock,
        entry({ spec: { ...EMPTY, name: 'Renamed District' }, fixtures }),
        0,
        {},
        NOW,
      ),
    ),
    [
      'domains[0].spec changed since the domain was created. Set onStart to reset or delete the data directory.',
    ],
  );
  writeJson('fixtures.json', fixturesWith('bob'));
  assert.deepEqual(
    configErrors(() =>
      ensureDomain(mock, entry({ spec: EMPTY, fixtures }), 0, {}, NOW),
    ),
    [
      'domains[0].fixtures changed since the domain was created. Set onStart to reset or delete the data directory.',
    ],
  );
});

test('reset recreates the domain with the current fixtures and keeps a key of this customer', (t) => {
  const { mock, entry, writeJson } = setup(t);
  const fixtures = writeJson('fixtures.json', fixturesWith('ada'));
  const domain = {
    spec: EMPTY,
    onStart: 'reset',
    fixtures,
    serviceAccounts: [{ out: 'keys/app.json', scopes: 'read' }],
  };
  const first = ensureDomain(mock, entry(domain), 0, {}, NOW);
  assert.equal(first.action, 'created');
  const [account] = first.serviceAccounts;
  const bytes = readFileSync(account.out);

  writeJson('fixtures.json', fixturesWith('bob'));
  const second = ensureDomain(mock, entry(domain), 0, {}, NOW + 60_000);
  assert.equal(second.action, 'reset');
  const reseeded = mock.domains.get(first.customerId)!;
  assert.equal(reseeded.record.seededAt, NOW + 60_000);
  assert.ok(findUser(reseeded.db, `bob@${PRIMARY}`));
  assert.equal(findUser(reseeded.db, `ada@${PRIMARY}`), undefined);
  assert.deepEqual(readFileSync(account.out), bytes);
  assert.equal(second.serviceAccounts[0].clientId, account.clientId);
  assert.equal(
    mock.registry.serviceAccountByEmail(account.clientEmail)?.customerId,
    first.customerId,
  );
  assert.deepEqual(
    mock.registry.grant(first.customerId, account.clientId),
    READ_SCOPES,
  );

  const other = mock.domains.create(
    { tier: 'empty', seed: 'other' },
    NOW,
  ).domain;
  const foreign = issueServiceAccount(mock.registry, other.customerId);
  writeFileSync(account.out, JSON.stringify(foreign));
  const third = ensureDomain(mock, entry(domain), 0, {}, NOW + 120_000);
  assert.notEqual(third.serviceAccounts[0].clientEmail, foreign.client_email);
  assert.equal(
    mock.registry.serviceAccountByEmail(third.serviceAccounts[0].clientEmail)
      ?.customerId,
    first.customerId,
  );

  writeFileSync(
    account.out,
    JSON.stringify({
      ...foreign,
      client_email: 'unknown@nowhere.iam.gserviceaccount.com',
    }),
  );
  const fourth = ensureDomain(mock, entry(domain), 0, {}, NOW + 180_000);
  const replaced = JSON.parse(readFileSync(account.out, 'utf8'));
  assert.equal(replaced.client_email, fourth.serviceAccounts[0].clientEmail);
  assert.notEqual(
    replaced.client_email,
    'unknown@nowhere.iam.gserviceaccount.com',
  );
  assert.equal(statSync(account.out).mode & 0o777, 0o600);
});

test('a second run replaces the faults, and an invalid rule names its path', (t) => {
  const { mock, entry } = setup(t);
  const domain = { spec: EMPTY, faults: [{ kind: 'error-rate', rate: 0.1 }] };
  const first = ensureDomain(mock, entry(domain), 0, {}, NOW);
  ensureDomain(mock, entry(domain), 0, {}, NOW);
  assert.equal(mock.faults.list(first.customerId).length, 1);
  // resolveConfig rejects this rule first. Skip it to reach the backstop in ensureDomain.
  const bogus = { ...entry({ spec: EMPTY }), faults: [{ kind: 'bogus' }] };
  assert.deepEqual(
    configErrors(() => ensureDomain(mock, bogus, 0, {}, NOW)),
    ['domains[0].faults[0]: Unknown fault kind.'],
  );
});
