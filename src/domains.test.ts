import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDomains, DomainError } from './domains.ts';
import { FixtureError, parseFixtures } from './seed/fixtures.ts';
import { resolveSpec } from './seed/spec.ts';
import { openRegistry } from './store/registry.ts';
import { row, rows } from './store/sqlite.ts';

const SPEC = {
  tier: 'small',
  seed: 'life',
  counts: { schools: 2, students: 60, staff: 10, devices: 80 },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'domains-'));
  const registry = openRegistry(join(dataDir, 'registry.sqlite'));
  return { dataDir, registry, domains: createDomains(dataDir, registry) };
}

const status = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return error.status;
    throw error;
  }
  return 0;
};

test('create seeds a file and registers the domain names', () => {
  const { dataDir, registry, domains } = setup();
  const { domain, result } = domains.create(SPEC, 1_000);
  assert.equal(result.counts.devices, 80);
  assert.ok(
    existsSync(join(dataDir, 'domains', `${domain.customerId}.sqlite`)),
  );
  assert.equal(
    registry.domainForName(domain.spec.primaryDomain),
    domain.customerId,
  );
  assert.equal(
    registry.domainForName(domain.spec.aliasDomain),
    domain.customerId,
  );
  assert.equal(domains.get(domain.customerId), domain);
});

test('duplicate seeds, duplicate names, and bad specs fail with a status', () => {
  const { domains } = setup();
  domains.create({ ...SPEC, name: 'Same District' }, 1_000);
  assert.equal(
    status(() => domains.create({ ...SPEC, name: 'Other' }, 1_000)),
    409,
  );
  assert.equal(
    status(() =>
      domains.create({ ...SPEC, seed: 'two', name: 'Same District' }, 1_000),
    ),
    409,
  );
  assert.equal(
    status(() => domains.create({ tier: 'huge', seed: 'x' }, 1_000)),
    400,
  );
});

test('reset reseeds from the stored specification', () => {
  const { registry, domains } = setup();
  const { domain } = domains.create(SPEC, 1_000);
  const result = domains.reset(domain.customerId, 5_000);
  assert.equal(result.counts.devices, 80);
  assert.equal(registry.getDomain(domain.customerId)?.seededAt, 5_000);
  const reopened = domains.get(domain.customerId)!;
  assert.equal(reopened.record.seededAt, 5_000);
  assert.equal(
    row<{ value: string }>(
      reopened.db
        .prepare("SELECT value FROM meta WHERE key = 'seededAt'")
        .get(),
    )?.value,
    '5000',
  );
});

test('delete removes the file and the registry entry', () => {
  const { dataDir, domains } = setup();
  const { domain } = domains.create(SPEC, 1_000);
  domains.delete(domain.customerId);
  assert.equal(domains.get(domain.customerId), undefined);
  assert.ok(
    !existsSync(join(dataDir, 'domains', `${domain.customerId}.sqlite`)),
  );
  assert.equal(
    status(() => domains.delete(domain.customerId)),
    404,
  );
});

test('settings merge, persist, and reject bad values', () => {
  const { registry, domains } = setup();
  const { domain } = domains.create(SPEC, 1_000);
  domains.updateSettings(domain.customerId, { quota: { perMinute: 10 } });
  assert.equal(
    domains.get(domain.customerId)?.record.settings.quota.perMinute,
    10,
  );
  assert.equal(
    registry.getDomain(domain.customerId)?.settings.quota.perMinute,
    10,
  );
  assert.equal(
    status(() =>
      domains.updateSettings(domain.customerId, { quota: { perMinute: -1 } }),
    ),
    400,
  );
  assert.equal(
    status(() => domains.updateSettings('C0missing', {})),
    404,
  );
});

const FIXED = { tier: 'empty', seed: 'fixed', name: 'Fixed District' };
const FIXED_DOMAIN = 'fixed-district.test';

test('a domain reset re-applies its stored fixtures', () => {
  const { domains } = setup();
  const data = parseFixtures(
    {
      users: [
        {
          primaryEmail: `pat@${FIXED_DOMAIN}`,
          givenName: 'Pat',
          familyName: 'Lee',
        },
      ],
    },
    'inline.json',
  );
  const { domain, result } = domains.create(FIXED, 1_000, {
    fixtures: { file: 'inline.json', data },
  });
  assert.equal(result.counts.users, 2);
  domain.db
    .prepare(
      "INSERT INTO users (id, primary_email, given_name, family_name, full_name, org_unit_path, is_admin, suspended, role, creation_time, ord) VALUES ('1999', ?, 'Stray', 'Row', 'Stray Row', '/', 0, 0, 'staff', 1000, 99)",
    )
    .run(`stray@${FIXED_DOMAIN}`);
  const reset = domains.reset(domain.customerId, 5_000);
  assert.equal(reset.counts.users, 2);
  const db = domains.get(domain.customerId)!.db;
  assert.deepEqual(
    rows<{ primary_email: string }>(
      db.prepare('SELECT primary_email FROM users ORDER BY ord').all(),
    ).map((user) => user.primary_email),
    [`admin@${FIXED_DOMAIN}`, `pat@${FIXED_DOMAIN}`],
  );
  assert.deepEqual(
    rows<{ key: string; value: string }>(
      db
        .prepare(
          "SELECT key, value FROM meta WHERE key IN ('fixtures', 'fixturesFile') ORDER BY key",
        )
        .all(),
    ).map((entry) => [entry.key, entry.value]),
    [
      ['fixtures', JSON.stringify(data)],
      ['fixturesFile', 'inline.json'],
    ],
  );
});

test('a fixtures error leaves no domain behind', () => {
  const { dataDir, registry, domains } = setup();
  const bad = parseFixtures(
    {
      users: [
        { primaryEmail: 'pat@elsewhere.test', givenName: 'P', familyName: 'L' },
      ],
    },
    'bad.json',
  );
  assert.throws(
    () =>
      domains.create(FIXED, 1_000, {
        fixtures: { file: 'bad.json', data: bad },
      }),
    (error: unknown) =>
      error instanceof FixtureError &&
      error.errors.join() ===
        "bad.json: users[0].primaryEmail must be on one of the customer's domains.",
  );
  const { customerId } = resolveSpec(FIXED);
  assert.equal(registry.getDomain(customerId), undefined);
  assert.equal(registry.domainForName(FIXED_DOMAIN), undefined);
  assert.equal(domains.get(customerId), undefined);
  assert.ok(!existsSync(join(dataDir, 'domains', `${customerId}.sqlite`)));
  assert.equal(domains.create(FIXED, 2_000).domain.customerId, customerId);
});
