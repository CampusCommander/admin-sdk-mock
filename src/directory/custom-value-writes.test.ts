import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { row } from '../store/sqlite.ts';
import { batchBody, batchStatuses } from '../testing/batch.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const SPEC = {
  tier: 'small',
  seed: 'custom-writes',
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
    { fieldName: 'HireDate', fieldType: 'DATE', displayName: 'Hire date' },
    { fieldName: 'Approved', fieldType: 'BOOL', displayName: 'Approved' },
    {
      fieldName: 'GuardianEmail',
      fieldType: 'EMAIL',
      displayName: 'Guardian email',
    },
    { fieldName: 'Ratio', fieldType: 'DOUBLE', displayName: 'Ratio' },
  ],
};

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const created = await api('POST', '/customer/my_customer/schemas', {
    body: SCHEMA,
  });
  assert.equal(created.status, 200);
  const student = row<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        "SELECT id, primary_email FROM users WHERE role = 'student' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!;
  const other = row<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        "SELECT id, primary_email FROM users WHERE role = 'student' ORDER BY ord LIMIT 1 OFFSET 1",
      )
      .get(),
  )!;
  const staff = row<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        "SELECT id, primary_email FROM users WHERE role = 'staff' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!;
  const values = async (id = student.id) => {
    const response = await api('GET', `/users/${id}`, {
      query: { projection: 'full' },
    });
    assert.equal(response.status, 200);
    return response.json().customSchemas as
      Record<string, Record<string, unknown>> | undefined;
  };
  const patch = async (body: unknown, id = student.id, method = 'PATCH') =>
    api(method, `/users/${id}`, { body });
  return { harness, domain, api, student, other, staff, values, patch };
}

test('a patch sets a value and keeps a field that it leaves out', async (t) => {
  const { values, patch } = await setup(t);
  const first = await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100' } },
  });
  assert.equal(first.status, 200);
  assert.deepEqual(await values(), { StudentInfo: { StudentID: 'S100' } });
  const second = await patch({
    customSchemas: { StudentInfo: { GradeLevel: 8 } },
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await values(), {
    StudentInfo: { GradeLevel: 8, StudentID: 'S100' },
  });
});

test('users.update merges custom values too', async (t) => {
  const { values, patch } = await setup(t);
  const response = await patch(
    {
      name: { givenName: 'Grace', familyName: 'Hopper' },
      customSchemas: { StudentInfo: { StudentID: 'S200' } },
    },
    undefined,
    'PUT',
  );
  assert.equal(response.status, 200);
  assert.equal(response.json().name.givenName, 'Grace');
  assert.deepEqual(await values(), { StudentInfo: { StudentID: 'S200' } });
});

test('null deletes a value, and a null category deletes every value', async (t) => {
  const { values, patch } = await setup(t);
  await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100', GradeLevel: 7 } },
  });
  const one = await patch({
    customSchemas: { StudentInfo: { GradeLevel: null } },
  });
  assert.equal(one.status, 200);
  assert.deepEqual(await values(), { StudentInfo: { StudentID: 'S100' } });
  const all = await patch({ customSchemas: { StudentInfo: null } });
  assert.equal(all.status, 200);
  assert.equal(await values(), undefined);
});

test('a multi-valued field takes the entry list', async (t) => {
  const { values, patch } = await setup(t);
  const response = await patch({
    customSchemas: {
      StudentInfo: {
        Programs: [{ value: 'Band' }, { value: 'ELL', type: 'home' }],
      },
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await values(), {
    StudentInfo: {
      Programs: [{ value: 'Band' }, { value: 'ELL', type: 'home' }],
    },
  });
});

test('each info type accepts its canonical value', async (t) => {
  const { values, patch } = await setup(t);
  const response = await patch({
    customSchemas: {
      StudentInfo: {
        HireDate: '2026-08-31',
        Approved: true,
        GuardianEmail: 'guardian@example.org',
        Ratio: 1.5,
        GradeLevel: 12,
      },
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await values(), {
    StudentInfo: {
      Approved: true,
      GradeLevel: 12,
      GuardianEmail: 'guardian@example.org',
      HireDate: '2026-08-31',
      Ratio: 1.5,
    },
  });
});

test('an unknown attribute answers 400 and changes nothing', async (t) => {
  const { values, patch } = await setup(t);
  const unknownSchema = await patch({
    customSchemas: { Robotics: { Team: 'blue' } },
  });
  assert.equal(unknownSchema.status, 400);
  assert.equal(unknownSchema.json().error.errors[0].reason, 'invalid');
  const unknownField = await patch({
    customSchemas: { StudentInfo: { Grade: 7 } },
  });
  assert.equal(unknownField.status, 400);
  assert.equal(await values(), undefined);
});

test('a value of the wrong type answers 400', async (t) => {
  const { values, patch } = await setup(t);
  const cases: Record<string, unknown>[] = [
    { StudentInfo: { GradeLevel: 'seven' } },
    { StudentInfo: { GradeLevel: 7.5 } },
    { StudentInfo: { Programs: 'Band' } },
    { StudentInfo: { Programs: [{ type: 'home' }] } },
    { StudentInfo: { StudentID: 12 } },
    { StudentInfo: { StudentID: '' } },
    { StudentInfo: { StudentID: 'x'.repeat(501) } },
    { StudentInfo: { HireDate: '31/08/2026' } },
    { StudentInfo: { Approved: 'yes' } },
    { StudentInfo: { GuardianEmail: 'not-an-address' } },
    { StudentInfo: { Ratio: 'half' } },
  ];
  for (const [index, customSchemas] of cases.entries()) {
    const response = await patch({ customSchemas });
    assert.equal(response.status, 400, `case ${index}`);
    assert.equal(
      response.json().error.errors[0].reason,
      'invalid',
      `case ${index}`,
    );
  }
  assert.equal(await values(), undefined);
});

test('a valid value beside a bad one writes nothing', async (t) => {
  const { values, patch } = await setup(t);
  const response = await patch({
    customSchemas: {
      StudentInfo: { StudentID: 'S100', GradeLevel: 'seven' },
    },
  });
  assert.equal(response.status, 400);
  assert.equal(await values(), undefined);
});

test('a value write to an unknown or a hidden user answers 404', async (t) => {
  const { harness, domain, api, staff } = await setup(t);
  const missing = await harness.request({
    host: 'admin.googleapis.com',
    method: 'PATCH',
    path: '/admin/directory/v1/users/nobody@example.org',
    token: grantToken(harness, domain, READ_WRITE_SCOPES),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customSchemas: { StudentInfo: { StudentID: 'S300' } },
    }),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.errors[0].reason, 'notFound');
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: staff.primary_email,
  });
  const hidden = await api('PATCH', `/users/${staff.primary_email}`, {
    body: { customSchemas: { StudentInfo: { StudentID: 'S301' } } },
  });
  assert.equal(hidden.status, 404);
});

test('a missing user fails only its own batch part', async (t) => {
  const { harness, domain, student } = await setup(t);
  const token = grantToken(harness, domain, READ_WRITE_SCOPES);
  const prefix = '/admin/directory/v1/users';
  const response = await harness.request({
    host: 'www.googleapis.com',
    path: '/batch/admin/directory_v1',
    method: 'POST',
    token,
    headers: { 'content-type': 'multipart/mixed; boundary=b' },
    body: batchBody(
      [
        {
          id: 'missing',
          method: 'PATCH',
          path: `${prefix}/nobody@example.org`,
          body: { customSchemas: { StudentInfo: { StudentID: 'S300' } } },
        },
        {
          id: 'found',
          method: 'PATCH',
          path: `${prefix}/${student.id}`,
          body: { customSchemas: { StudentInfo: { StudentID: 'S400' } } },
        },
      ],
      'b',
    ),
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...batchStatuses(response.text).entries()].sort(), [
    ['found', 200],
    ['missing', 404],
  ]);
  const read = await harness.request({
    host: 'admin.googleapis.com',
    path: `${prefix}/${student.id}`,
    query: { projection: 'full' },
    token,
  });
  assert.deepEqual(read.json().customSchemas, {
    StudentInfo: { StudentID: 'S400' },
  });
});
test('an update that leaves out a field removes its values from every user', async (t) => {
  const { api, student, other, values, patch } = await setup(t);
  await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100', GradeLevel: 7 } },
  });
  await patch(
    { customSchemas: { StudentInfo: { StudentID: 'S101', GradeLevel: 9 } } },
    other.id,
  );
  const kept = SCHEMA.fields.filter((field) => field.fieldName !== 'StudentID');
  const updated = await api(
    'PUT',
    '/customer/my_customer/schemas/StudentInfo',
    {
      body: { ...SCHEMA, fields: kept },
    },
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(await values(), { StudentInfo: { GradeLevel: 7 } });
  assert.deepEqual(await values(other.id), {
    StudentInfo: { GradeLevel: 9 },
  });
  void student;
});

test('a delete removes every value of the schema from every user', async (t) => {
  const { api, other, values, patch } = await setup(t);
  await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100', GradeLevel: 7 } },
  });
  await patch(
    { customSchemas: { StudentInfo: { StudentID: 'S101' } } },
    other.id,
  );
  const deleted = await api(
    'DELETE',
    '/customer/my_customer/schemas/StudentInfo',
  );
  assert.equal(deleted.status, 204);
  assert.equal(await values(), undefined);
  assert.equal(await values(other.id), undefined);
});

test('users.list searches a searchable custom field', async (t) => {
  const { api, student, other, patch } = await setup(t);
  await patch({
    customSchemas: {
      StudentInfo: {
        StudentID: 'S100',
        GradeLevel: 7,
        Programs: [{ value: 'Band' }],
      },
    },
  });
  await patch(
    { customSchemas: { StudentInfo: { StudentID: 'S101', GradeLevel: 9 } } },
    other.id,
  );
  const search = async (query: string) => {
    const response = await api('GET', '/users', {
      query: { customer: 'my_customer', maxResults: 500, query },
    });
    assert.equal(response.status, 200, response.text.slice(0, 200));
    return (response.json().users as { primaryEmail: string }[]).map(
      (user) => user.primaryEmail,
    );
  };
  assert.deepEqual(await search('StudentInfo.StudentID=S100'), [
    student.primary_email,
  ]);
  assert.deepEqual(
    (await search('StudentInfo.StudentID:S10*')).sort(),
    [student.primary_email, other.primary_email].sort(),
  );
  assert.deepEqual(
    await search('StudentInfo.StudentID:S10* StudentInfo.GradeLevel=9'),
    [other.primary_email],
  );
  assert.deepEqual(await search('StudentInfo.Programs:Band'), [
    student.primary_email,
  ]);
});

test('a query on an unknown or an unsearchable custom field answers 400', async (t) => {
  const { api, student } = await setup(t);
  const added = await api('PUT', '/customer/my_customer/schemas/StudentInfo', {
    body: {
      ...SCHEMA,
      fields: [
        ...SCHEMA.fields,
        {
          fieldName: 'Nickname',
          fieldType: 'STRING',
          displayName: 'Nickname',
          indexed: false,
        },
      ],
    },
  });
  assert.equal(added.status, 200);
  const cases = [
    'Robotics.Team=blue',
    'StudentInfo.Grade=7',
    'StudentInfo.Nickname=Ana',
  ];
  for (const query of cases) {
    const response = await api('GET', '/users', {
      query: { customer: 'my_customer', query },
    });
    assert.equal(response.status, 400, query);
    assert.equal(response.json().error.errors[0].reason, 'invalid', query);
  }
  const existing = await api('GET', '/users', {
    query: { customer: 'my_customer', query: 'StudentInfo.StudentID=S100' },
  });
  assert.equal(existing.status, 200);
  void student;
});
