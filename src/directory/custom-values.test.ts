import assert from 'node:assert/strict';
import test from 'node:test';
import { row } from '../store/sqlite.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { putCustomValue } from './custom-values.ts';

const P = 'https://www.googleapis.com/auth/';
const SCHEMA_WRITE = [`${P}admin.directory.userschema`];
const USER_READ = [`${P}admin.directory.user.readonly`];
const SPEC = {
  tier: 'small',
  seed: 'custom-values',
  counts: { schools: 1, students: 12, staff: 3, devices: 5 },
};
const SCHEMA = {
  schemaName: 'StudentInfo',
  displayName: 'Student information',
  fields: [
    { fieldName: 'StudentID', fieldType: 'STRING', displayName: 'Student ID' },
    {
      fieldName: 'GradeLevel',
      fieldType: 'INT64',
      displayName: 'Grade level',
    },
    {
      fieldName: 'Programs',
      fieldType: 'STRING',
      displayName: 'Programs',
      multiValued: true,
    },
  ],
};

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const write = directoryClient(
    harness,
    grantToken(harness, domain, SCHEMA_WRITE),
  );
  const read = directoryClient(harness, grantToken(harness, domain, USER_READ));
  const created = await write('POST', '/customer/my_customer/schemas', {
    body: SCHEMA,
  });
  assert.equal(created.status, 200);
  const students = domain.db
    .prepare(
      "SELECT id, primary_email FROM users WHERE role = 'student' ORDER BY ord LIMIT 2",
    )
    .all() as { id: string; primary_email: string }[];
  const staff = row<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        "SELECT id, primary_email FROM users WHERE role = 'staff' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!;
  putCustomValue(domain.db, students[0].id, 'StudentInfo', 'StudentID', 'S100');
  putCustomValue(domain.db, students[0].id, 'StudentInfo', 'GradeLevel', 7);
  putCustomValue(domain.db, students[0].id, 'StudentInfo', 'Programs', [
    { value: 'Band' },
    { value: 'ELL' },
  ]);
  putCustomValue(domain.db, students[1].id, 'StudentInfo', 'StudentID', 'S101');
  return { harness, domain, write, read, students, staff };
}

test('basic omits customSchemas, and full returns every value', async (t) => {
  const { read, students } = await setup(t);
  const basic = await read('GET', `/users/${students[0].id}`);
  assert.equal(basic.status, 200);
  assert.equal(Object.hasOwn(basic.json(), 'customSchemas'), false);
  const full = await read('GET', `/users/${students[0].id}`, {
    query: { projection: 'full' },
  });
  assert.equal(full.status, 200);
  assert.deepEqual(full.json().customSchemas, {
    StudentInfo: {
      GradeLevel: 7,
      Programs: [{ value: 'Band' }, { value: 'ELL' }],
      StudentID: 'S100',
    },
  });
  const other = await read('GET', `/users/${students[1].id}`, {
    query: { projection: 'full' },
  });
  assert.deepEqual(other.json().customSchemas, {
    StudentInfo: { StudentID: 'S101' },
  });
});

test('custom returns only the schemas that the mask names', async (t) => {
  const { read, students, staff } = await setup(t);
  const masked = await read('GET', `/users/${students[0].id}`, {
    query: { projection: 'custom', customFieldMask: 'StudentInfo' },
  });
  assert.deepEqual(Object.keys(masked.json().customSchemas), ['StudentInfo']);
  const other = await read('GET', `/users/${students[0].id}`, {
    query: { projection: 'custom', customFieldMask: 'StaffInfo' },
  });
  assert.equal(other.status, 400);
  assert.equal(other.json().error.errors[0].reason, 'invalid');
  const listed = await read('GET', '/users', {
    query: {
      customer: 'my_customer',
      maxResults: 500,
      projection: 'custom',
      customFieldMask: 'StaffInfo',
    },
  });
  assert.equal(listed.status, 200);
  assert.equal(
    (listed.json().users as object[]).every(
      (user) => !Object.hasOwn(user, 'customSchemas'),
    ),
    true,
  );
  const unmasked = await read('GET', `/users/${students[0].id}`, {
    query: { projection: 'custom' },
  });
  assert.equal(Object.hasOwn(unmasked.json(), 'customSchemas'), false);
  const empty = await read('GET', `/users/${staff.id}`, {
    query: { projection: 'full' },
  });
  assert.equal(Object.hasOwn(empty.json(), 'customSchemas'), false);
});

test('users.list returns the values of each listed user', async (t) => {
  const { read, students } = await setup(t);
  const response = await read('GET', '/users', {
    query: { customer: 'my_customer', maxResults: 500, projection: 'full' },
  });
  assert.equal(response.status, 200);
  const byId = new Map(
    (response.json().users as { id: string; customSchemas?: unknown }[]).map(
      (user) => [user.id, user],
    ),
  );
  assert.deepEqual(
    (byId.get(students[0].id) as { customSchemas: unknown }).customSchemas,
    {
      StudentInfo: {
        GradeLevel: 7,
        Programs: [{ value: 'Band' }, { value: 'ELL' }],
        StudentID: 'S100',
      },
    },
  );
  assert.equal(
    Object.hasOwn(byId.get(students[1].id) as object, 'customSchemas'),
    true,
  );
  const basic = await read('GET', '/users', {
    query: { customer: 'my_customer', maxResults: 500 },
  });
  assert.equal(
    (basic.json().users as object[]).every(
      (user) => !Object.hasOwn(user, 'customSchemas'),
    ),
    true,
  );
});

test('a domain without the custom tables keeps the resource of 0.3.0', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const read = directoryClient(harness, grantToken(harness, domain, USER_READ));
  const user = row<{ id: string }>(
    domain.db
      .prepare("SELECT id FROM users WHERE role = 'student' LIMIT 1")
      .get(),
  )!;
  const response = await read('GET', `/users/${user.id}`, {
    query: { projection: 'full' },
  });
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(response.json(), 'customSchemas'), false);
  // A domain without custom tables holds no schema, so a mask name answers 400.
  const masked = await read('GET', `/users/${user.id}`, {
    query: { projection: 'custom', customFieldMask: 'StudentInfo' },
  });
  assert.equal(masked.status, 400);
  assert.equal(masked.json().error.errors[0].reason, 'invalid');
  assert.equal(response.json().archived, false);
  assert.equal(response.json().isEnrolledIn2Sv, false);
  assert.equal(Object.hasOwn(response.json(), 'organizations'), false);
  assert.equal(
    row<{ name: string }>(
      domain.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_schemas'",
        )
        .get(),
    ),
    undefined,
  );
});
