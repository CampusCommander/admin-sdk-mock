import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDomainDb } from '../store/domain-db.ts';
import { outsideMemberId } from '../store/group-lookup.ts';
import { row, rows, transaction } from '../store/sqlite.ts';
import { hashDatabase } from '../testing/db-hash.ts';
import { DAY_MS } from './context.ts';
import {
  applyFixtures,
  FixtureError,
  loadFixtures,
  parseFixtures,
} from './fixtures.ts';
import { ouId } from './layout.ts';
import { CURRENT_MODELS } from './models.ts';
import { deviceReports } from './reports.ts';
import { seedDomain } from './seed.ts';
import { resolveSpec, type ResolvedSpec } from './spec.ts';

const SEEDED_AT = Date.UTC(2026, 9, 9, 12);
const FILE = 'fixtures.json';
const EMPTY = { tier: 'empty', seed: 'fix', name: 'Fixture District' };
const SMALL = {
  tier: 'small',
  seed: 'fix',
  name: 'Fixture District',
  counts: { schools: 1, students: 20, staff: 5, devices: 10 },
};
const PRIMARY = 'fixture-district.test';

/** Seed a domain, then apply the fixtures that `build` returns inside one transaction. */
function applied(
  build: (spec: ResolvedSpec) => unknown,
  input: Record<string, unknown> = EMPTY,
) {
  const db = openDomainDb(':memory:');
  const spec = resolveSpec(input);
  seedDomain(db, spec, SEEDED_AT);
  const counts = transaction(db, () =>
    applyFixtures(db, spec, parseFixtures(build(spec), FILE), SEEDED_AT, FILE),
  );
  return { db, spec, counts };
}

const plain = (db: DatabaseSync, sql: string, ...params: string[]) =>
  rows<Record<string, unknown>>(db.prepare(sql).all(...params)).map(
    (entry) => ({ ...entry }),
  );

const count = (db: DatabaseSync, table: string) =>
  Number(
    row<{ n: number }>(db.prepare(`SELECT count(*) AS n FROM ${table}`).get())
      ?.n,
  );

function errorsOf(work: () => unknown): string[] {
  try {
    work();
  } catch (error) {
    if (error instanceof FixtureError) return error.errors;
    throw error;
  }
  return assert.fail('Expected a FixtureError.');
}

test('the empty tier seeds the domain rows, the root OU, and one administrator', () => {
  const db = openDomainDb(':memory:');
  const spec = resolveSpec(EMPTY);
  const result = seedDomain(db, spec, SEEDED_AT);
  assert.equal(spec.primaryDomain, PRIMARY);
  assert.deepEqual(plain(db, 'SELECT org_unit_id, path, name FROM orgunits'), [
    { org_unit_id: ouId('fix', '/'), path: '/', name: 'Fixture District' },
  ]);
  assert.deepEqual(
    plain(
      db,
      'SELECT primary_email, given_name, family_name, org_unit_path, is_admin, suspended, role, creation_time, ord FROM users',
    ),
    [
      {
        primary_email: `admin@${PRIMARY}`,
        given_name: 'Admin',
        family_name: 'Account',
        org_unit_path: '/',
        is_admin: 1,
        suspended: 0,
        role: 'admin',
        creation_time: SEEDED_AT - 1000 * DAY_MS,
        ord: 0,
      },
    ],
  );
  assert.match(
    String(row<{ id: string }>(db.prepare('SELECT id FROM users').get())?.id),
    /^1\d{20}$/,
  );
  assert.equal(count(db, 'devices'), 0);
  assert.equal(count(db, 'groups'), 0);
  assert.equal(count(db, 'group_members'), 0);
  assert.ok(count(db, 'domains') >= 2);
  assert.deepEqual(result.counts, {
    orgUnits: 1,
    users: 1,
    devices: 0,
    groups: 0,
    memberships: 0,
  });
  assert.equal(result.adminEmail, `admin@${PRIMARY}`);
});

test('an OU fixture creates its missing ancestors', () => {
  const { db, counts } = applied(() => ({
    orgUnits: [{ path: '/Schools/North/Grade 5', description: 'Fifth' }],
  }));
  assert.equal(counts.orgUnits, 3);
  assert.deepEqual(
    plain(
      db,
      "SELECT org_unit_id, path, name, description, parent_id, parent_path, depth, kind FROM orgunits WHERE path != '/' ORDER BY ord",
    ),
    [
      {
        org_unit_id: ouId('fix', '/Schools'),
        path: '/Schools',
        name: 'Schools',
        description: '',
        parent_id: ouId('fix', '/'),
        parent_path: '/',
        depth: 1,
        kind: 'container',
      },
      {
        org_unit_id: ouId('fix', '/Schools/North'),
        path: '/Schools/North',
        name: 'North',
        description: '',
        parent_id: ouId('fix', '/Schools'),
        parent_path: '/Schools',
        depth: 2,
        kind: 'container',
      },
      {
        org_unit_id: ouId('fix', '/Schools/North/Grade 5'),
        path: '/Schools/North/Grade 5',
        name: 'Grade 5',
        description: 'Fifth',
        parent_id: ouId('fix', '/Schools/North'),
        parent_path: '/Schools/North',
        depth: 3,
        kind: 'container',
      },
    ],
  );
});

test('a user fixture stores every field', () => {
  const fixtures = () => ({
    orgUnits: [{ path: '/Staff' }],
    users: [
      {
        primaryEmail: `Pat.Lee@${PRIMARY}`,
        givenName: 'Pat',
        familyName: 'Lee',
        orgUnitPath: '/Staff',
        isAdmin: true,
        suspended: true,
        aliases: [`PLee@${PRIMARY}`],
        externalIds: [
          { value: 'E1', type: 'organization' },
          { value: 'X2', type: 'custom' },
        ],
        id: '100000000000000000001',
      },
      { primaryEmail: `sam@${PRIMARY}`, givenName: 'Sam', familyName: 'Ray' },
    ],
  });
  const { db, counts } = applied(fixtures);
  assert.equal(counts.users, 2);
  assert.deepEqual(
    plain(
      db,
      'SELECT id, primary_email, given_name, family_name, full_name, org_unit_path, is_admin, suspended, suspension_reason, external_id, external_ids, role, creation_time, last_login_time FROM users WHERE primary_email = ?',
      `pat.lee@${PRIMARY}`,
    ),
    [
      {
        id: '100000000000000000001',
        primary_email: `pat.lee@${PRIMARY}`,
        given_name: 'Pat',
        family_name: 'Lee',
        full_name: 'Pat Lee',
        org_unit_path: '/Staff',
        is_admin: 1,
        suspended: 1,
        suspension_reason: 'ADMIN',
        external_id: 'E1',
        external_ids: JSON.stringify([
          { value: 'E1', type: 'organization' },
          { value: 'X2', type: 'custom' },
        ]),
        role: 'staff',
        creation_time: SEEDED_AT - 30 * DAY_MS,
        last_login_time: null,
      },
    ],
  );
  assert.deepEqual(plain(db, 'SELECT alias, user_id FROM user_aliases'), [
    { alias: `plee@${PRIMARY}`, user_id: '100000000000000000001' },
  ]);
  const sam = plain(
    db,
    'SELECT id, org_unit_path, is_admin, suspended, suspension_reason, external_id, external_ids FROM users WHERE primary_email = ?',
    `sam@${PRIMARY}`,
  )[0];
  assert.match(String(sam.id), /^1\d{20}$/);
  assert.deepEqual(
    { ...sam, id: 'checked' },
    {
      id: 'checked',
      org_unit_path: '/',
      is_admin: 0,
      suspended: 0,
      suspension_reason: null,
      external_id: null,
      external_ids: null,
    },
  );
  const again = applied(fixtures);
  assert.equal(hashDatabase(again.db), hashDatabase(db));
});

test('a device fixture fills every column from its serial number', () => {
  const model = CURRENT_MODELS[2].name;
  const fixtures = () => ({
    orgUnits: [{ path: '/Carts' }],
    devices: [
      {
        serialNumber: 'SN-1',
        model,
        orgUnitPath: '/Carts',
        annotatedUser: 'cart',
      },
      {
        serialNumber: 'SN-2',
        status: 'DISABLED',
        deviceId: 'device-two',
        annotatedAssetId: 'A-2',
        annotatedLocation: 'Library',
        notes: 'Loaner',
        lastSync: '2026-10-01T08:00:00.000Z',
      },
    ],
  });
  const { db, spec, counts } = applied(fixtures);
  assert.equal(counts.devices, 2);
  const [first, second] = plain(db, 'SELECT * FROM devices ORDER BY ord');
  assert.deepEqual(
    {
      serial_number: first.serial_number,
      model: first.model,
      org_unit_path: first.org_unit_path,
      org_unit_id: first.org_unit_id,
      annotated_user: first.annotated_user,
      status: first.status,
      last_sync: first.last_sync,
      category: first.category,
      misplaced: first.misplaced,
    },
    {
      serial_number: 'SN-1',
      model,
      org_unit_path: '/Carts',
      org_unit_id: ouId('fix', '/Carts'),
      annotated_user: 'cart',
      status: 'ACTIVE',
      last_sync: SEEDED_AT - DAY_MS,
      category: 'one-to-one',
      misplaced: 0,
    },
  );
  assert.match(String(first.device_id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    {
      device_id: second.device_id,
      status: second.status,
      model: second.model,
      org_unit_path: second.org_unit_path,
      annotated_asset_id: second.annotated_asset_id,
      annotated_location: second.annotated_location,
      notes: second.notes,
      last_sync: second.last_sync,
    },
    {
      device_id: 'device-two',
      status: 'DISABLED',
      model: CURRENT_MODELS[0].name,
      org_unit_path: '/',
      annotated_asset_id: 'A-2',
      annotated_location: 'Library',
      notes: 'Loaner',
      last_sync: Date.parse('2026-10-01T08:00:00.000Z'),
    },
  );
  const required = plain(db, 'PRAGMA table_info(devices)')
    .filter((column) => column.notnull === 1)
    .map((column) => String(column.name));
  for (const device of [first, second])
    for (const column of required)
      assert.notEqual(device[column], null, column);
  assert.ok(
    Number(first.first_enrollment_time) <= Number(first.last_sync),
    'enrollment precedes the last sync',
  );
  assert.ok(
    'cpuStatusReports' in
      deviceReports(spec.seed, row(db.prepare('SELECT * FROM devices').get())!),
  );
  const again = applied(fixtures);
  assert.deepEqual(plain(again.db, 'SELECT * FROM devices ORDER BY ord'), [
    first,
    second,
  ]);
  assert.deepEqual(
    errorsOf(() =>
      applied(() => ({
        devices: [{ serialNumber: 'SN-3', model: 'Toaster 3000' }],
      })),
    ),
    [`${FILE}: devices[0].model names no model in the catalog.`],
  );
});

test('group fixtures resolve every kind of member', () => {
  const { db, spec, counts } = applied((spec) => ({
    users: [
      {
        primaryEmail: `owner@${PRIMARY}`,
        givenName: 'Olive',
        familyName: 'Oak',
      },
    ],
    groups: [
      {
        email: `team@${PRIMARY}`,
        name: 'Team',
        description: 'The team',
        aliases: [`crew@${PRIMARY}`],
        members: [
          { email: `owner@${PRIMARY}`, role: 'OWNER' },
          { email: `admin@${PRIMARY}` },
          { email: `later@${PRIMARY}` },
          { id: spec.customerId },
          { email: 'Friend@Example.com' },
        ],
      },
      { email: `later@${PRIMARY}` },
    ],
  }));
  assert.equal(counts.groups, 2);
  const groups = plain(
    db,
    'SELECT id, email, name, description, admin_created, created_at FROM groups ORDER BY email',
  );
  assert.deepEqual(
    groups.map(({ id, ...rest }) => {
      assert.match(String(id), /^0[0-9a-z]{14}$/);
      return rest;
    }),
    [
      {
        email: `later@${PRIMARY}`,
        name: 'later',
        description: '',
        admin_created: 1,
        created_at: SEEDED_AT - 30 * DAY_MS,
      },
      {
        email: `team@${PRIMARY}`,
        name: 'Team',
        description: 'The team',
        admin_created: 1,
        created_at: SEEDED_AT - 30 * DAY_MS,
      },
    ],
  );
  const [later, team] = groups;
  assert.deepEqual(plain(db, 'SELECT alias, group_id FROM group_aliases'), [
    { alias: `crew@${PRIMARY}`, group_id: team.id },
  ]);
  const userId = (email: string) =>
    row<{ id: string }>(
      db.prepare('SELECT id FROM users WHERE primary_email = ?').get(email),
    )!.id;
  assert.deepEqual(
    plain(
      db,
      'SELECT group_id, member_id, email, type, role, delivery, added_at FROM group_members ORDER BY id',
    ),
    [
      [userId(`owner@${PRIMARY}`), `owner@${PRIMARY}`, 'USER', 'OWNER'],
      [userId(`admin@${PRIMARY}`), `admin@${PRIMARY}`, 'USER', 'MEMBER'],
      [later.id, `later@${PRIMARY}`, 'GROUP', 'MEMBER'],
      [spec.customerId, '', 'CUSTOMER', 'MEMBER'],
      [
        outsideMemberId('friend@example.com'),
        'friend@example.com',
        'USER',
        'MEMBER',
      ],
    ].map(([member_id, email, type, role]) => ({
      group_id: team.id,
      member_id,
      email,
      type,
      role,
      delivery: 'ALL_MAIL',
      added_at: SEEDED_AT - 30 * DAY_MS,
    })),
  );
});

test('a member type that matches its key is accepted', () => {
  const { db } = applied((spec) => ({
    users: [
      {
        primaryEmail: `owner@${PRIMARY}`,
        givenName: 'Olive',
        familyName: 'Oak',
      },
    ],
    groups: [
      {
        email: `team@${PRIMARY}`,
        members: [
          { email: `owner@${PRIMARY}`, type: 'USER' },
          { email: `later@${PRIMARY}`, type: 'GROUP' },
          { id: spec.customerId, type: 'CUSTOMER' },
          { email: 'friend@example.com', type: 'USER' },
        ],
      },
      { email: `later@${PRIMARY}` },
    ],
  }));
  assert.deepEqual(
    plain(db, 'SELECT type FROM group_members ORDER BY id').map(
      (member) => member.type,
    ),
    ['USER', 'GROUP', 'CUSTOMER', 'USER'],
  );
});

test('a member type that differs from its key is an error', () => {
  assert.deepEqual(
    errorsOf(() =>
      applied((spec) => ({
        groups: [
          {
            email: `team@${PRIMARY}`,
            members: [
              { email: `later@${PRIMARY}`, type: 'USER' },
              { email: 'friend@example.com', type: 'GROUP' },
              { id: spec.customerId, type: 'GROUP' },
            ],
          },
          { email: `later@${PRIMARY}` },
        ],
      })),
    ),
    [
      `${FILE}: groups[0].members[0].type is USER but the key names a GROUP.`,
      `${FILE}: groups[0].members[1].type is GROUP but the key names a USER.`,
      `${FILE}: groups[0].members[2].type is GROUP but the key names a CUSTOMER.`,
    ],
  );
});

test('reference errors name the file, the path, and the problem', () => {
  const user = (primaryEmail: string) => ({
    primaryEmail,
    givenName: 'Pat',
    familyName: 'Lee',
  });
  const cases: [(spec: ResolvedSpec) => unknown, string[]][] = [
    [
      () => ({ users: [user('pat@elsewhere.test')] }),
      [
        `${FILE}: users[0].primaryEmail must be on one of the customer's domains.`,
      ],
    ],
    [
      () => ({ users: [user(`pat@${PRIMARY}`), user(`PAT@${PRIMARY}`)] }),
      [`${FILE}: users[1].primaryEmail is already in use.`],
    ],
    [
      () => ({
        groups: [
          {
            email: `team@${PRIMARY}`,
            members: [{ email: `nobody@${PRIMARY}` }],
          },
        ],
      }),
      [
        `${FILE}: groups[0].members[0] names no user, group, customer, or outside address.`,
      ],
    ],
    [
      () => ({
        groups: [
          { email: `a@${PRIMARY}`, members: [{ email: `b@${PRIMARY}` }] },
          { email: `b@${PRIMARY}`, members: [{ email: `a@${PRIMARY}` }] },
        ],
      }),
      [`${FILE}: groups[1].members[0] makes a membership cycle.`],
    ],
    [
      () => ({ devices: [{ serialNumber: 'SN-1', orgUnitPath: '/Nowhere' }] }),
      [`${FILE}: devices[0].orgUnitPath names no OU.`],
    ],
    [() => ({ things: [] }), [`${FILE}: things is not an allowed key.`]],
    [
      () => ({
        users: [user('pat@elsewhere.test')],
        devices: [{ serialNumber: 'SN-1', orgUnitPath: '/Nowhere' }],
      }),
      [
        `${FILE}: users[0].primaryEmail must be on one of the customer's domains.`,
        `${FILE}: devices[0].orgUnitPath names no OU.`,
      ],
    ],
  ];
  for (const [build, expected] of cases)
    assert.deepEqual(
      errorsOf(() => applied(build)),
      expected,
    );
});

test('fixtures apply on top of a generated tier', () => {
  const { db, counts } = applied(
    () => ({
      orgUnits: [{ path: '/Fixtures' }],
      users: [
        {
          primaryEmail: `pat@${PRIMARY}`,
          givenName: 'Pat',
          familyName: 'Lee',
          orgUnitPath: '/Fixtures',
        },
      ],
      devices: [{ serialNumber: 'SN-1', orgUnitPath: '/Fixtures' }],
      groups: [
        {
          email: `fixture-team@${PRIMARY}`,
          members: [
            { email: `pat@${PRIMARY}` },
            { email: `all-staff@${PRIMARY}` },
          ],
        },
      ],
    }),
    SMALL,
  );
  assert.deepEqual(counts, { orgUnits: 1, users: 1, devices: 1, groups: 1 });
  assert.equal(count(db, 'devices'), 11);
  assert.equal(
    row<{ value: string }>(
      db.prepare("SELECT value FROM meta WHERE key = 'deviceCount'").get(),
    )?.value,
    '11',
  );

  const db2 = openDomainDb(':memory:');
  const spec = resolveSpec(SMALL);
  seedDomain(db2, spec, SEEDED_AT);
  const before = hashDatabase(db2);
  const fixtures = parseFixtures(
    {
      users: [
        { primaryEmail: `admin@${PRIMARY}`, givenName: 'A', familyName: 'B' },
      ],
    },
    FILE,
  );
  assert.deepEqual(
    errorsOf(() =>
      transaction(db2, () =>
        applyFixtures(db2, spec, fixtures, SEEDED_AT, FILE),
      ),
    ),
    [`${FILE}: users[0].primaryEmail is already in use.`],
  );
  assert.equal(hashDatabase(db2), before);
});

test('shape errors name the file and the JSON path', () => {
  assert.deepEqual(
    errorsOf(() =>
      parseFixtures(
        {
          orgUnits: [{ path: 'Schools' }],
          users: [{ primaryEmail: 'not-an-address', givenName: 'P' }],
          devices: [{ serialNumber: 'SN-1', status: 'LOST', lastSync: 'soon' }],
          groups: [{ email: `team@${PRIMARY}`, members: [{}] }],
        },
        FILE,
      ),
    ),
    [
      `${FILE}: users[0].familyName is required.`,
      `${FILE}: devices[0].status must be one of: ACTIVE, DISABLED, DEPROVISIONED.`,
      `${FILE}: orgUnits[0].path must be / or a path such as /Schools/North.`,
      `${FILE}: users[0].primaryEmail must be an email address.`,
      `${FILE}: devices[0].lastSync must be an ISO 8601 time.`,
      `${FILE}: groups[0].members[0] must have exactly one of email and id.`,
    ],
  );
  assert.deepEqual(
    errorsOf(() => parseFixtures([], FILE)),
    [`${FILE}: The fixtures file must be an object.`],
  );
  assert.deepEqual(parseFixtures({}, FILE), {
    orgUnits: [],
    users: [],
    devices: [],
    groups: [],
  });
});

test('loadFixtures reads a file and reports read and JSON errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixtures-'));
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ orgUnits: [{ path: '/Labs' }] }));
  assert.deepEqual(loadFixtures(good), {
    orgUnits: [{ path: '/Labs' }],
    users: [],
    devices: [],
    groups: [],
  });
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{ "users": [');
  const [json] = errorsOf(() => loadFixtures(broken));
  assert.ok(
    json.startsWith(`${broken}: The fixtures file is not valid JSON (`),
    json,
  );
  const missing = join(dir, 'missing.json');
  const [read] = errorsOf(() => loadFixtures(missing));
  assert.ok(
    read.startsWith(`${missing}: The fixtures file cannot be read (`),
    read,
  );
});
