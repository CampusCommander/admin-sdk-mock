import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDomains, DomainError } from './domains.ts';
import { openRegistry } from './store/registry.ts';
import { row } from './store/sqlite.ts';

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
