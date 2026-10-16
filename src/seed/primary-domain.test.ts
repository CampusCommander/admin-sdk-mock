import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDomainDb } from '../store/domain-db.ts';
import { rows } from '../store/sqlite.ts';
import { seedDomain, type SeedResult } from './seed.ts';
import { resolveSpec, type ResolvedSpec } from './spec.ts';

const SEEDED_AT = Date.UTC(2026, 9, 16, 12);
const OVERRIDE = 'easton-consulting.com';

function seeded(input: Record<string, unknown>): {
  db: DatabaseSync;
  spec: ResolvedSpec;
  result: SeedResult;
} {
  const db = openDomainDb(':memory:');
  const spec = resolveSpec(input);
  const result = seedDomain(db, spec, SEEDED_AT);
  return { db, spec, result };
}

const emailsOf = (db: DatabaseSync) =>
  rows<{ primary_email: string }>(
    db.prepare('SELECT primary_email FROM users ORDER BY ord LIMIT 20').all(),
  ).map((user) => user.primary_email);

const serialsOf = (db: DatabaseSync) =>
  rows<{ serial_number: string }>(
    db.prepare('SELECT serial_number FROM devices ORDER BY ord LIMIT 20').all(),
  ).map((device) => device.serial_number);

/**
 * The seed data of release 0.1.0, captured on `aec201b` before `primaryDomain` existed.
 * The capture seeds each specification in memory at 2026-10-16T12:00:00Z and reads
 * `users.ord` and `devices.ord` in order. Existing users depend on these values.
 */
const GOLDEN = [
  {
    input: { tier: 'small', seed: 'golden-small' },
    customerId: 'C0azpqxq0',
    primaryDomain: 'oakdale-school-district.test',
    studentDomain: 'students.oakdale-school-district.test',
    aliasDomain: 'oakdale-school-district-k12.test',
    adminEmail: 'admin@oakdale-school-district.test',
    counts: {
      orgUnits: 42,
      users: 563,
      devices: 600,
      groups: 113,
      memberships: 2736,
    },
    userEmails: [
      'admin@oakdale-school-district.test',
      'technology.director@oakdale-school-district.test',
      'helpdesk@oakdale-school-district.test',
      'donna.ramirez@oakdale-school-district.test',
      'arjun.hayes@oakdale-school-district.test',
      'jason.phillips@oakdale-school-district.test',
      'lin.lewis@oakdale-school-district.test',
      'ava.alvarez@oakdale-school-district.test',
      'darius.allen@oakdale-school-district.test',
      'hiroshi.patel@oakdale-school-district.test',
      'joseph.vasquez@oakdale-school-district.test',
      'luis.johnson@oakdale-school-district.test',
      'jonathan.ford@oakdale-school-district.test',
      'nicole.sullivan@oakdale-school-district.test',
      'valeria.young@oakdale-school-district.test',
      'stephanie.mitchell@oakdale-school-district.test',
      'carol.holmes@oakdale-school-district.test',
      'carlos.owens@oakdale-school-district.test',
      'jeffrey.lee@oakdale-school-district.test',
      'nicole.allen@oakdale-school-district.test',
    ],
    serials: [
      'PFAYTBHD',
      'PFSBMDFX',
      'NXH0D28FAWFSK7ATKC9SGH',
      'PFGFUZSZ',
      '5CDVYR59YE',
      'PFB3C8ZP',
      'M3KNC8NJADWX',
      'PFV478N0',
      'PFZR6UT9',
      '1DZHD0S',
      'MSX8E4U53Q8C',
      'PF7TUDP3',
      '0A0X6Z1',
      'NXHBRSMR6HTTV5BYZ5CE3Q',
      '5CD0LDHCZV',
      'NXHXCWH0XYB6V2WN5Y9KUF',
      'NXH9AHWTWCM1DUMS2AQD1J',
      'PFVW1B6J',
      'NXHS9BESKG95RZZ95BSRCV',
      '5CDF3QY4XD',
    ],
  },
  {
    input: { tier: 'medium', seed: 'golden-medium' },
    customerId: 'C0tepo4gw',
    primaryDomain: 'brookhaven-public-schools.test',
    studentDomain: 'students.brookhaven-public-schools.test',
    aliasDomain: 'brookhaven-public-schools-k12.test',
    adminEmail: 'admin@brookhaven-public-schools.test',
    counts: {
      orgUnits: 188,
      users: 6703,
      devices: 7000,
      groups: 1159,
      memberships: 32394,
    },
    userEmails: [
      'admin@brookhaven-public-schools.test',
      'technology.director@brookhaven-public-schools.test',
      'helpdesk@brookhaven-public-schools.test',
      'michael.roberts@brookhaven-public-schools.test',
      'christine.flores@brookhaven-public-schools.test',
      'janet.roberts@brookhaven-public-schools.test',
      'isabella.lopez@brookhaven-public-schools.test',
      'kimberly.kennedy@brookhaven-public-schools.test',
      'mia.dixon@brookhaven-public-schools.test',
      'andre.collins@brookhaven-public-schools.test',
      'alexander.mills@brookhaven-public-schools.test',
      'andrew.hall@brookhaven-public-schools.test',
      'ivan.butler@brookhaven-public-schools.test',
      'carolyn.mitchell@brookhaven-public-schools.test',
      'aaliyah.washington@brookhaven-public-schools.test',
      'william.ramos@brookhaven-public-schools.test',
      'katherine.hill@brookhaven-public-schools.test',
      'kenneth.edwards@brookhaven-public-schools.test',
      'lin.taylor@brookhaven-public-schools.test',
      'anna.cooper@brookhaven-public-schools.test',
    ],
    serials: [
      'PFJJ0PAH',
      '5CDATHNA48',
      'PFM37XZR',
      'PFCQZXCU',
      'PFEUXXCW',
      'PFBVQ3XC',
      'NXHPJDCFZ35V5PMQA2NX1N',
      'NXHEH6TPZ8H2Z112LPMTRY',
      'YUUJ7FP',
      'FFX1QA9',
      '5CDFDNBCW3',
      '5CDWF3XG9P',
      'PF7P1JXL',
      'CTLTNJPMHC4Y',
      'PFNZSKGW',
      'NXHUPN13H2CCFCT9V9RDVB',
      'PFGG63NT',
      '5CD0XQW8QJ',
      '5CDCE3QTEY',
      'N43BSYA',
    ],
  },
];

test('a specification without primaryDomain yields the seed data of 0.1.0', () => {
  for (const golden of GOLDEN) {
    const { db, spec, result } = seeded(golden.input);
    assert.equal(spec.customerId, golden.customerId);
    assert.equal(spec.primaryDomain, golden.primaryDomain);
    assert.equal(spec.studentDomain, golden.studentDomain);
    assert.equal(spec.aliasDomain, golden.aliasDomain);
    assert.equal(result.adminEmail, golden.adminEmail);
    assert.equal(
      rows<{ primary_email: string }>(
        db.prepare('SELECT primary_email FROM users WHERE is_admin = 1').all(),
      ).some((user) => user.primary_email === golden.adminEmail),
      true,
    );
    assert.deepEqual(result.counts, golden.counts);
    assert.deepEqual(emailsOf(db), golden.userEmails);
    assert.deepEqual(serialsOf(db), golden.serials);
    db.close();
  }
});

/**
 * The group IDs of release 0.1.0, captured on `aec201b`: the SHA-256 of every
 * `email|id` line, in email order. The capture also seeds each specification in
 * memory at 2026-10-16T12:00:00Z. The group ID follows its address, so this pins
 * the key of the derived address.
 */
const GOLDEN_GROUP_IDS = [
  {
    input: { tier: 'small', seed: 'golden-small' },
    count: 113,
    digest: 'fcb5ecaa1282afc209ae555305ba7f34804190f3867939eebd86965b79c09775',
  },
  {
    input: { tier: 'medium', seed: 'golden-medium' },
    count: 1159,
    digest: '50611d1e86ca62c5d96e01cee63866b75dfc94a9b2db635c61fe27b9de76148f',
  },
  {
    // A seed whose student domain is the primary domain.
    input: { tier: 'small', seed: 'named-domain' },
    count: 105,
    digest: '09dbe3b49caa42fa47f633f47e3b8a2e6a279fdbe290823e6a0002c7378a0927',
  },
];

test('the group IDs of 0.1.0 stay the same', () => {
  for (const golden of GOLDEN_GROUP_IDS) {
    const { db } = seeded(golden.input);
    const lines = rows<{ id: string; email: string }>(
      db.prepare('SELECT id, email FROM groups ORDER BY email').all(),
    ).map((group) => `${group.email}|${group.id}`);
    assert.equal(lines.length, golden.count);
    assert.equal(
      createHash('sha256').update(lines.join('\n')).digest('hex'),
      golden.digest,
    );
    db.close();
  }
});

/** Every seeded table, with the column that orders its rows without a domain. */
const TABLES: [table: string, order: string][] = [
  ['orgunits', 'org_unit_id'],
  ['users', 'id'],
  ['user_aliases', 'user_id'],
  ['devices', 'device_id'],
  ['device_commands', 'command_id'],
  ['groups', 'id'],
  ['group_aliases', 'group_id'],
  ['group_members', 'id'],
  ['domains', 'is_primary DESC, creation_time'],
];

/** Every row of every seeded table, and the stored specification without the override. */
function dump(db: DatabaseSync): string {
  const data: Record<string, unknown> = {};
  for (const [table, order] of TABLES)
    data[table] = rows<Record<string, unknown>>(
      db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
    );
  const meta: Record<string, unknown>[] = rows<{ key: string; value: string }>(
    db
      .prepare("SELECT key, value FROM meta WHERE key != 'spec' ORDER BY key")
      .all(),
  );
  const stored = JSON.parse(
    rows<{ value: string }>(
      db.prepare("SELECT value FROM meta WHERE key = 'spec'").all(),
    )[0].value,
  ) as Record<string, unknown>;
  delete stored.primaryDomain;
  meta.push({ key: 'spec', value: stored });
  data.meta = meta;
  return JSON.stringify(data, null, 2);
}

test('primaryDomain changes only the domain strings of the seeded data', () => {
  const input = {
    tier: 'small',
    seed: 'isolation-sep',
    name: 'Isolation District',
  };
  const base = seeded(input);
  const over = seeded({ ...input, primaryDomain: OVERRIDE });
  assert.equal(base.spec.studentDomain, 'students.isolation-district.test');
  assert.equal(over.spec.studentDomain, `students.${OVERRIDE}`);
  assert.equal(over.spec.aliasDomain, `k12.${OVERRIDE}`);
  assert.equal(over.spec.slug, base.spec.slug);
  assert.equal(over.spec.customerId, base.spec.customerId);
  // The override appears in the seeded addresses, so the comparison below is not vacuous.
  assert.ok(dump(over.db).includes(OVERRIDE));
  const mapped = dump(over.db)
    .replaceAll(`students.${OVERRIDE}`, base.spec.studentDomain)
    .replaceAll(`k12.${OVERRIDE}`, base.spec.aliasDomain)
    .replaceAll(OVERRIDE, base.spec.primaryDomain);
  assert.equal(mapped, dump(base.db));
  base.db.close();
  over.db.close();
});

test('every seeded address sits on the override or stays a .test domain', () => {
  const { db, spec } = seeded({
    tier: 'small',
    seed: 'contained',
    name: 'Containment District',
    primaryDomain: OVERRIDE,
  });
  const addresses = [
    ...rows<{ primary_email: string }>(
      db.prepare('SELECT primary_email FROM users').all(),
    ).map((row) => row.primary_email),
    ...rows<{ alias: string }>(
      db.prepare('SELECT alias FROM user_aliases').all(),
    ).map((row) => row.alias),
    ...rows<{ email: string }>(
      db.prepare('SELECT email FROM groups').all(),
    ).map((row) => row.email),
    ...rows<{ alias: string }>(
      db.prepare('SELECT alias FROM group_aliases').all(),
    ).map((row) => row.alias),
    ...rows<{ email: string }>(
      db.prepare('SELECT email FROM group_members').all(),
    ).map((row) => row.email),
    ...rows<{ domain_name: string }>(
      db.prepare('SELECT domain_name FROM domains').all(),
    ).map((row) => row.domain_name),
  ].filter((address) => address !== '');
  assert.ok(addresses.length > 1000);
  assert.ok(addresses.some((address) => address.endsWith(`.${OVERRIDE}`)));
  for (const address of addresses) {
    const domain = address.slice(address.lastIndexOf('@') + 1);
    assert.ok(
      domain === OVERRIDE ||
        domain.endsWith(`.${OVERRIDE}`) ||
        domain.endsWith('.test'),
      address,
    );
  }
  assert.equal(spec.primaryDomain, OVERRIDE);
  db.close();
});
