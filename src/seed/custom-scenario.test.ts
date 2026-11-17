import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES } from '../auth/scopes.ts';
import { openDomainDb } from '../store/domain-db.ts';
import { row, rows } from '../store/sqlite.ts';
import { hashDatabase } from '../testing/db-hash.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { seedDomain } from './seed.ts';
import { resolveSpec, SpecError } from './spec.ts';

const SEEDED_AT = Date.UTC(2026, 9, 9, 12);
const INPUT = {
  tier: 'small',
  seed: 'scenario',
  counts: { schools: 1, students: 12, staff: 3, devices: 5 },
  customSchemas: true,
};

function seeded(input: Record<string, unknown>, custom = false) {
  const db = openDomainDb(':memory:');
  const spec = resolveSpec(input);
  const result = seedDomain(db, spec, SEEDED_AT, {
    customSchemas: custom,
  });
  return { db, spec, result };
}

test('the seed field writes the three categories and ten attributes', () => {
  const { db } = seeded(INPUT, true);
  const schemas = rows<{
    schema_id: string;
    schema_name: string;
    display_name: string;
  }>(db.prepare('SELECT * FROM custom_schemas ORDER BY ord').all());
  assert.deepEqual(
    schemas.map((schema) => schema.schema_name),
    ['StudentInfo', 'StaffInfo', 'DeviceProgram'],
  );
  assert.deepEqual(
    schemas.map((schema) => schema.display_name),
    ['Student information', 'Staff information', 'Device program'],
  );
  const fields = rows<{
    schema_id: string;
    field_name: string;
    field_type: string;
    multi_valued: number;
    indexed: number;
    read_access_type: string;
    numeric_min: number | null;
    numeric_max: number | null;
  }>(db.prepare('SELECT * FROM custom_schema_fields ORDER BY ord').all());
  assert.equal(fields.length, 10);
  const of = (schemaId: string) =>
    fields
      .filter((field) => field.schema_id === schemaId)
      .map((field) => field.field_name);
  assert.deepEqual(of(schemas[0].schema_id), [
    'StudentID',
    'GradeLevel',
    'GraduationYear',
    'Homeroom',
    'Programs',
  ]);
  assert.deepEqual(of(schemas[1].schema_id), [
    'EmployeeID',
    'Building',
    'HireDate',
    'Certifications',
  ]);
  assert.deepEqual(of(schemas[2].schema_id), ['TakeHomeApproved']);
  const grade = fields.find((field) => field.field_name === 'GradeLevel')!;
  assert.equal(grade.field_type, 'INT64');
  assert.deepEqual([grade.numeric_min, grade.numeric_max], [0, 12]);
  const programs = fields.find((field) => field.field_name === 'Programs')!;
  assert.equal(programs.multi_valued, 1);
  assert.equal(programs.indexed, 1);
  assert.equal(programs.read_access_type, 'ALL_DOMAIN_USERS');
});

test('the scenario writes values on the students and the staff', () => {
  const { db } = seeded(INPUT, true);
  const values = rows<{
    user_id: string;
    schema_name: string;
    field_name: string;
    value_json: string;
  }>(
    db
      .prepare(
        'SELECT user_id, schema_name, field_name, value_json FROM user_custom_values ORDER BY user_id, schema_name, field_name',
      )
      .all(),
  );
  const known = new Set(
    rows<{ schema_name: string; field_name: string }>(
      db
        .prepare(
          'SELECT s.schema_name, f.field_name FROM custom_schema_fields f JOIN custom_schemas s ON s.schema_id = f.schema_id',
        )
        .all(),
    ).map((field) => `${field.schema_name}.${field.field_name}`),
  );
  for (const value of values)
    assert.ok(
      known.has(`${value.schema_name}.${value.field_name}`),
      `${value.schema_name}.${value.field_name}`,
    );
  const students = rows<{ id: string }>(
    db
      .prepare("SELECT id FROM users WHERE role = 'student' ORDER BY ord")
      .all(),
  );
  const staff = rows<{ id: string }>(
    db
      .prepare("SELECT id FROM users WHERE role != 'student' ORDER BY ord")
      .all(),
  );
  const has = (userId: string, field: string) =>
    values.some(
      (value) =>
        value.user_id === userId &&
        value.schema_name === 'StudentInfo' &&
        value.field_name === field,
    );
  for (const student of students) {
    assert.ok(has(student.id, 'StudentID'));
    assert.ok(has(student.id, 'GradeLevel'));
    assert.ok(has(student.id, 'GraduationYear'));
    assert.ok(has(student.id, 'Homeroom'));
    const grade = JSON.parse(
      values.find(
        (value) =>
          value.user_id === student.id && value.field_name === 'GradeLevel',
      )!.value_json,
    ) as number;
    assert.ok(Number.isInteger(grade) && grade >= 0 && grade <= 12);
  }
  const hasStaff = (userId: string, field: string) =>
    values.some(
      (value) =>
        value.user_id === userId &&
        value.schema_name === 'StaffInfo' &&
        value.field_name === field,
    );
  for (const member of staff) {
    assert.ok(hasStaff(member.id, 'EmployeeID'));
    assert.ok(hasStaff(member.id, 'Building'));
    assert.ok(hasStaff(member.id, 'HireDate'));
    const hired = values.find(
      (value) => value.user_id === member.id && value.field_name === 'HireDate',
    )!.value_json;
    assert.match(JSON.parse(hired) as string, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.ok(
    values.some(
      (value) =>
        value.schema_name === 'DeviceProgram' &&
        value.field_name === 'TakeHomeApproved',
    ),
  );
});

test('the scenario writes the archived flag, two-step verification, and organizations', () => {
  const { db } = seeded(INPUT, true);
  const extras = rows<{
    user_id: string;
    archived: number;
    enrolled_in_2sv: number;
    organizations: string | null;
  }>(db.prepare('SELECT * FROM user_profile_extra').all());
  const users = Number(
    row<{ n: number }>(db.prepare('SELECT count(*) AS n FROM users').get())!.n,
  );
  assert.equal(extras.length, users);
  assert.ok(extras.some((extra) => extra.archived === 1));
  assert.ok(extras.some((extra) => extra.enrolled_in_2sv === 1));
  const staff = rows<{ id: string }>(
    db.prepare("SELECT id FROM users WHERE role = 'staff'").all(),
  );
  for (const member of staff) {
    const extra = extras.find((entry) => entry.user_id === member.id)!;
    const organizations = JSON.parse(extra.organizations!) as {
      name: string;
      department: string;
      title: string;
      primary: boolean;
    }[];
    assert.equal(organizations.length, 1);
    assert.equal(organizations[0].primary, true);
    assert.equal(typeof organizations[0].department, 'string');
    assert.equal(typeof organizations[0].title, 'string');
  }
});

test('the empty tier honors the opt-in seed field', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const schemaNames = (db: import('node:sqlite').DatabaseSync) =>
    rows<{ schema_name: string }>(
      db.prepare('SELECT schema_name FROM custom_schemas ORDER BY ord').all(),
    ).map((entry) => entry.schema_name);
  const created = harness.mock.domains.create(
    { tier: 'empty', seed: 'empty-opt-in', customSchemas: true },
    SEEDED_AT,
  );
  const counts = {
    orgUnits: 1,
    users: 1,
    devices: 0,
    groups: 0,
    memberships: 0,
  };
  assert.deepEqual(created.result.counts, counts);
  assert.deepEqual(schemaNames(created.domain.db), [
    'StudentInfo',
    'StaffInfo',
    'DeviceProgram',
  ]);
  const reset = harness.mock.domains.reset(
    created.domain.customerId,
    SEEDED_AT + 60_000,
  );
  assert.deepEqual(reset.counts, counts);
  const reopened = harness.mock.domains.get(created.domain.customerId)!;
  assert.deepEqual(schemaNames(reopened.db), [
    'StudentInfo',
    'StaffInfo',
    'DeviceProgram',
  ]);
  const api = directoryClient(
    harness,
    grantToken(harness, reopened, READ_SCOPES),
  );
  const listed = await api('GET', '/customer/my_customer/schemas');
  assert.equal(listed.status, 200);
  assert.equal(listed.json().schemas.length, 3);
  // The no-flag baseline keeps the database of 0.3.0.
  const plain = harness.mock.domains.create(
    { tier: 'empty', seed: 'empty-plain' },
    SEEDED_AT,
  );
  assert.deepEqual(plain.result.counts, counts);
  assert.equal(
    row(
      plain.domain.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_schemas'",
        )
        .get(),
    ),
    undefined,
  );
});

test('a domain without the seed field hashes as in 0.3.0', () => {
  const cases: [Record<string, unknown>, string][] = [
    [
      { tier: 'small', seed: 'same', counts: { devices: 300 } },
      '0d83feda2e176654d81723832bbbd6094fd44d824c3b6390f5dc193749cbda6c',
    ],
    [
      {
        tier: 'small',
        seed: 'hash',
        counts: { schools: 1, students: 12, staff: 3, devices: 5 },
      },
      '2a81f15472d8be296c55a217dcafe344cd2bc3fb8cb601752d8c03dad4d59751',
    ],
    [
      { tier: 'empty', seed: 'hash-empty' },
      '7e3d82c3b976478e077486ecfa68496a5ef365f83eeec8c3a3d6caf6b1cbad5a',
    ],
  ];
  for (const [input, expected] of cases) {
    const { db } = seeded(input);
    assert.equal(hashDatabase(db), expected, JSON.stringify(input));
    assert.equal(
      row(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_schemas'",
          )
          .get(),
      ),
      undefined,
    );
  }
});

test('the seed field validates as a boolean', () => {
  assert.throws(
    () => resolveSpec({ ...INPUT, customSchemas: 'yes' }),
    SpecError,
  );
  assert.equal(
    resolveSpec({ tier: 'small', seed: 's', customSchemas: false }).tier,
    'small',
  );
});

test('a seeded domain reads the scenario through the user routes', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, INPUT);
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_SCOPES),
  );
  const listed = await api('GET', '/customer/my_customer/schemas');
  assert.equal(listed.status, 200);
  assert.equal(listed.json().schemas.length, 3);
  const student = row<{ id: string }>(
    domain.db
      .prepare(
        "SELECT id FROM users WHERE role = 'student' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!;
  const user = await api('GET', `/users/${student.id}`, {
    query: { projection: 'full' },
  });
  assert.equal(user.status, 200);
  const custom = user.json().customSchemas as Record<string, unknown>;
  assert.ok(Object.hasOwn(custom, 'StudentInfo'));
  assert.equal(typeof user.json().isEnrolledIn2Sv, 'boolean');
  assert.equal(typeof user.json().archived, 'boolean');
  const searched = await api('GET', '/users', {
    query: { customer: 'my_customer', query: 'StudentInfo.Homeroom:B*' },
  });
  assert.equal(searched.status, 200);
  assert.ok(searched.json().users.length > 0);
});

test('the seeded profile fields reach the user routes', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, INPUT);
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_SCOPES),
  );
  const stored = new Map(
    rows<{
      user_id: string;
      archived: number;
      enrolled_in_2sv: number;
      organizations: string | null;
    }>(domain.db.prepare('SELECT * FROM user_profile_extra').all()).map(
      (entry) => [entry.user_id, entry],
    ),
  );
  const users = rows<{ id: string; role: string }>(
    domain.db.prepare('SELECT id, role FROM users ORDER BY ord').all(),
  );
  assert.ok(users.some((user) => stored.get(user.id)!.archived === 1));
  assert.ok(users.some((user) => stored.get(user.id)!.enrolled_in_2sv === 1));
  for (const user of users) {
    const response = await api('GET', `/users/${user.id}`, {
      query: { projection: 'full' },
    });
    assert.equal(response.status, 200, user.id);
    const body = response.json();
    const extra = stored.get(user.id)!;
    assert.equal(body.archived, extra.archived === 1, user.id);
    assert.equal(body.isEnrolledIn2Sv, extra.enrolled_in_2sv === 1, user.id);
    if (extra.organizations === null) {
      assert.equal(Object.hasOwn(body, 'organizations'), false, user.id);
      continue;
    }
    assert.deepEqual(
      body.organizations,
      JSON.parse(extra.organizations),
      user.id,
    );
  }
  const listed = await api('GET', '/users', {
    query: { customer: 'my_customer', maxResults: 500, projection: 'full' },
  });
  assert.equal(listed.status, 200);
  const page = listed.json().users as {
    id: string;
    archived: boolean;
    isEnrolledIn2Sv: boolean;
    organizations?: unknown[];
  }[];
  assert.equal(page.length, users.length);
  for (const user of page) {
    const extra = stored.get(user.id)!;
    assert.equal(user.archived, extra.archived === 1, user.id);
    assert.equal(user.isEnrolledIn2Sv, extra.enrolled_in_2sv === 1, user.id);
    if (extra.organizations === null) {
      assert.equal(Object.hasOwn(user, 'organizations'), false, user.id);
      continue;
    }
    const organizations = JSON.parse(extra.organizations) as {
      name: string;
      department: string;
      title: string;
      primary: boolean;
    }[];
    assert.deepEqual(user.organizations, organizations, user.id);
    assert.equal(user.organizations[0].name, domain.spec.districtName, user.id);
    assert.equal(typeof user.organizations[0].department, 'string', user.id);
    assert.equal(typeof user.organizations[0].title, 'string', user.id);
  }
});
