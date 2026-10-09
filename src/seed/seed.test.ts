import assert from 'node:assert/strict';
import test from 'node:test';
import { openDomainDb } from '../store/domain-db.ts';
import { row, rows } from '../store/sqlite.ts';
import { hashDatabase } from '../testing/db-hash.ts';
import { DAY_MS } from './context.ts';
import { seedDomain } from './seed.ts';
import { resolveSpec } from './spec.ts';

const SEEDED_AT = Date.UTC(2026, 9, 9, 12);
const INPUT = {
  tier: 'medium',
  seed: 'rates',
  counts: { schools: 8, students: 4000, staff: 400, devices: 6000 },
};

function seeded(input: Record<string, unknown> = INPUT) {
  const db = openDomainDb(':memory:');
  const spec = resolveSpec(input);
  const result = seedDomain(db, spec, SEEDED_AT);
  return { db, spec, result };
}

const shared = seeded();
const share = (where: string, of = '1 = 1') =>
  Number(
    row<{ n: number }>(
      shared.db
        .prepare(
          `SELECT count(*) AS n FROM devices WHERE (${of}) AND (${where})`,
        )
        .get(),
    )?.n,
  ) /
  Number(
    row<{ n: number }>(
      shared.db.prepare(`SELECT count(*) AS n FROM devices WHERE ${of}`).get(),
    )?.n,
  );

test('the seed reports the requested counts', () => {
  assert.equal(shared.result.counts.devices, 6000);
  assert.equal(shared.result.counts.users, 4403);
  assert.ok(shared.result.counts.orgUnits > 50);
  assert.equal(shared.result.adminEmail, `admin@${shared.spec.primaryDomain}`);
});

test('device statuses follow the rates', () => {
  assert.ok(Math.abs(share("status = 'DISABLED'") - 0.02) < 0.01);
  assert.ok(Math.abs(share("status = 'DEPROVISIONED'") - 0.05) < 0.015);
});

test('misplaced, unassigned, and expired shares follow the rates', () => {
  assert.ok(Math.abs(share('misplaced = 1') - 0.02) < 0.01);
  assert.ok(
    Math.abs(
      share('annotated_user IS NULL', "category IN ('one-to-one', 'staff')") -
        0.15,
    ) < 0.03,
  );
  assert.ok(Math.abs(share(`aue < ${SEEDED_AT}`) - 0.15) < 0.03);
});

test('every device points at an existing OU of the expected kind', () => {
  const mismatches = rows<{ n: number }>(
    shared.db
      .prepare(
        `SELECT count(*) AS n FROM devices d LEFT JOIN orgunits o ON o.path = d.org_unit_path
         WHERE o.path IS NULL OR o.org_unit_id != d.org_unit_id
            OR (d.misplaced = 0 AND o.kind != 'devices')
            OR (d.misplaced = 1 AND o.kind != 'users')`,
      )
      .all(),
  );
  assert.equal(mismatches[0].n, 0);
});

test('timestamps stay in order and in the past', () => {
  const bad = row<{ n: number }>(
    shared.db
      .prepare(
        `SELECT count(*) AS n FROM devices WHERE last_sync > ? OR last_sync < first_enrollment_time
           OR last_enrollment_time < first_enrollment_time OR last_enrollment_time > last_sync`,
      )
      .get(SEEDED_AT),
  );
  assert.equal(bad?.n, 0);
  const recent = share(
    `last_sync >= ${SEEDED_AT - 3 * DAY_MS}`,
    "status = 'ACTIVE'",
  );
  assert.ok(Math.abs(recent - 0.7) < 0.05, `recent ${recent}`);
});

test('deprovisioned devices carry a reason and no recent users', () => {
  assert.equal(
    share(
      'deprovision_reason IS NULL OR recent_users IS NOT NULL',
      "status = 'DEPROVISIONED'",
    ),
    0,
  );
});

test('the domain table holds the primary domain and its alias', () => {
  const domains = rows<{ domain_name: string; alias_of: string | null }>(
    shared.db.prepare('SELECT domain_name, alias_of FROM domains').all(),
  );
  assert.ok(
    domains.some((domain) => domain.domain_name === shared.spec.primaryDomain),
  );
  assert.ok(
    domains.some(
      (domain) =>
        domain.domain_name === shared.spec.aliasDomain &&
        domain.alias_of === shared.spec.primaryDomain,
    ),
  );
});

test('the same specification and seeding time produce identical data', () => {
  const small = { tier: 'small', seed: 'same', counts: { devices: 300 } };
  assert.equal(hashDatabase(seeded(small).db), hashDatabase(seeded(small).db));
  assert.notEqual(
    hashDatabase(seeded(small).db),
    hashDatabase(seeded({ ...small, seed: 'different' }).db),
  );
});
