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

test('users.update with null deletes a value, and a null category deletes every value', async (t) => {
  const { values, patch } = await setup(t);
  await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100', GradeLevel: 7 } },
  });
  const one = await patch(
    { customSchemas: { StudentInfo: { GradeLevel: null } } },
    undefined,
    'PUT',
  );
  assert.equal(one.status, 200);
  assert.deepEqual(await values(), { StudentInfo: { StudentID: 'S100' } });
  const all = await patch(
    { customSchemas: { StudentInfo: null } },
    undefined,
    'PUT',
  );
  assert.equal(all.status, 200);
  assert.equal(await values(), undefined);
});

test('users.patch keeps a value, a category, or every value that it names with null', async (t) => {
  const { values, patch } = await setup(t);
  await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100', GradeLevel: 7 } },
  });
  const before = await values();
  for (const customSchemas of [
    { StudentInfo: { GradeLevel: null } },
    { StudentInfo: null },
    null,
  ]) {
    const response = await patch({ customSchemas });
    assert.equal(response.status, 200);
    assert.deepEqual(await values(), before);
  }
});

test('a users.patch batch part keeps every value that it names with null', async (t) => {
  const { harness, domain, student, values, patch } = await setup(t);
  await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100', GradeLevel: 7 } },
  });
  const token = grantToken(harness, domain, READ_WRITE_SCOPES);
  const path = `/admin/directory/v1/users/${student.id}`;
  const response = await harness.request({
    host: 'www.googleapis.com',
    path: '/batch/admin/directory_v1',
    method: 'POST',
    token,
    headers: { 'content-type': 'multipart/mixed; boundary=b' },
    body: batchBody(
      [
        {
          id: 'field',
          method: 'PATCH',
          path,
          body: { customSchemas: { StudentInfo: { GradeLevel: null } } },
        },
        {
          id: 'category',
          method: 'PATCH',
          path,
          body: { customSchemas: { StudentInfo: null } },
        },
        {
          id: 'all',
          method: 'PATCH',
          path,
          body: { customSchemas: null },
        },
      ],
      'b',
    ),
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...batchStatuses(response.text).entries()].sort(), [
    ['all', 200],
    ['category', 200],
    ['field', 200],
  ]);
  assert.deepEqual(await values(), {
    StudentInfo: { GradeLevel: 7, StudentID: 'S100' },
  });
});

test('a users.update batch part deletes the values that it names with null', async (t) => {
  const { harness, domain, student, values, patch } = await setup(t);
  await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100', GradeLevel: 7 } },
  });
  const token = grantToken(harness, domain, READ_WRITE_SCOPES);
  const path = `/admin/directory/v1/users/${student.id}`;
  const send = async (id: string, body: unknown) => {
    const response = await harness.request({
      host: 'www.googleapis.com',
      path: '/batch/admin/directory_v1',
      method: 'POST',
      token,
      headers: { 'content-type': 'multipart/mixed; boundary=b' },
      body: batchBody([{ id, method: 'PUT', path, body }], 'b'),
    });
    assert.equal(response.status, 200, id);
    assert.deepEqual([...batchStatuses(response.text).entries()], [[id, 200]]);
  };
  await send('field', { customSchemas: { StudentInfo: { GradeLevel: null } } });
  assert.deepEqual(await values(), { StudentInfo: { StudentID: 'S100' } });
  await send('category', { customSchemas: { StudentInfo: null } });
  assert.equal(await values(), undefined);
  await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100', GradeLevel: 7 } },
  });
  await send('all', { customSchemas: null });
  assert.equal(await values(), undefined);
});

test('a custom read answers 400 when the mask names a schema that the customer does not hold', async (t) => {
  const { api, student } = await setup(t);
  for (const customFieldMask of ['Robotics', 'StudentInfo,Robotics']) {
    const missing = await api('GET', `/users/${student.id}`, {
      query: { projection: 'custom', customFieldMask },
    });
    assert.equal(missing.status, 400, customFieldMask);
    assert.equal(
      missing.json().error.errors[0].reason,
      'invalid',
      customFieldMask,
    );
  }
  const held = await api('GET', `/users/${student.id}`, {
    query: { projection: 'custom', customFieldMask: 'StudentInfo' },
  });
  assert.equal(held.status, 200);
  // users.list keeps its answer, as live check L3 sent no such call.
  const listed = await api('GET', '/users', {
    query: {
      customer: 'my_customer',
      maxResults: 500,
      projection: 'custom',
      customFieldMask: 'Robotics',
    },
  });
  assert.equal(listed.status, 200);
});

test('a value write answer holds customSchemas', async (t) => {
  const { other, values, patch } = await setup(t);
  const patched = await patch({
    customSchemas: { StudentInfo: { StudentID: 'S100' } },
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.json().customSchemas, {
    StudentInfo: { StudentID: 'S100' },
  });
  const updated = await patch(
    { customSchemas: { StudentInfo: { GradeLevel: 7 } } },
    undefined,
    'PUT',
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json().customSchemas, {
    StudentInfo: { GradeLevel: 7, StudentID: 'S100' },
  });
  assert.deepEqual(await values(), {
    StudentInfo: { GradeLevel: 7, StudentID: 'S100' },
  });
  const cleared = await patch({ customSchemas: null }, undefined, 'PUT');
  assert.equal(cleared.status, 200);
  assert.equal(Object.hasOwn(cleared.json(), 'customSchemas'), false);
  const empty = await patch(
    { name: { givenName: 'Grace', familyName: 'Hopper' } },
    other.id,
    'PUT',
  );
  assert.equal(empty.status, 200);
  assert.equal(Object.hasOwn(empty.json(), 'customSchemas'), false);
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

test('a string value stops at 500 characters', async (t) => {
  const { api, values, patch } = await setup(t);
  const fifty = 'a'.repeat(500);
  const accepted = await patch({
    customSchemas: { StudentInfo: { StudentID: fifty } },
  });
  assert.equal(accepted.status, 200);
  assert.equal((await values())!.StudentInfo.StudentID, fifty);
  const refused = await patch({
    customSchemas: { StudentInfo: { StudentID: 'a'.repeat(501) } },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().error.errors[0].reason, 'invalid');
  assert.equal((await values())!.StudentInfo.StudentID, fifty);
  const multi = await patch({
    customSchemas: { StudentInfo: { Programs: [{ value: 'a'.repeat(501) }] } },
  });
  assert.equal(multi.status, 400);
  const name = await api('POST', '/customer/my_customer/schemas', {
    body: { ...SCHEMA, schemaName: 'LongInfo', displayName: 'x' },
  });
  assert.equal(name.status, 200);
  const limit = await patch({
    customSchemas: { LongInfo: { StudentID: 'b'.repeat(501) } },
  });
  assert.equal(limit.status, 400);
  void api;
});

test('a multi-valued entry follows the type of its field', async (t) => {
  const { api, values, patch } = await setup(t);
  const created = await api('POST', '/customer/my_customer/schemas', {
    body: {
      schemaName: 'Scores',
      displayName: 'Scores',
      fields: [
        {
          fieldName: 'Points',
          fieldType: 'INT64',
          displayName: 'Points',
          multiValued: true,
        },
      ],
    },
  });
  assert.equal(created.status, 200);
  const refused = await patch({
    customSchemas: { Scores: { Points: [{ value: 'seven' }] } },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().error.errors[0].reason, 'invalid');
  const accepted = await patch({
    customSchemas: { Scores: { Points: [{ value: 7 }, { value: '9' }] } },
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(
    ((await values())!.Scores.Points as { value: number }[]).map(
      (entry) => entry.value,
    ),
    [7, 9],
  );
});

test('a schema and a field named like a prototype key round-trip', async (t) => {
  const { api, student, values } = await setup(t);
  const proto = await api('POST', '/customer/my_customer/schemas', {
    body: {
      schemaName: '__proto__',
      displayName: 'Prototype names',
      fields: [
        { fieldName: 'reviewMarker', fieldType: 'STRING', displayName: 'Mark' },
      ],
    },
  });
  assert.equal(proto.status, 200);
  const fieldNames = await api('POST', '/customer/my_customer/schemas', {
    body: {
      schemaName: 'FieldNames',
      displayName: 'Field names',
      fields: [
        { fieldName: '__proto__', fieldType: 'STRING', displayName: 'Proto' },
        {
          fieldName: 'constructor',
          fieldType: 'STRING',
          displayName: 'Constructor',
        },
      ],
    },
  });
  assert.equal(fieldNames.status, 200);
  const written = await api('PATCH', `/users/${student.id}`, {
    // A JSON document, because an object literal would set the prototype instead.
    body: '{"customSchemas":{"__proto__":{"reviewMarker":"schema-key"},"FieldNames":{"__proto__":"field-key","constructor":"own-key"}}}',
  });
  assert.equal(written.status, 200);
  const full = (await values()) as Record<string, Record<string, unknown>>;
  assert.equal(Object.hasOwn(full, '__proto__'), true);
  assert.equal(full.__proto__.reviewMarker, 'schema-key');
  assert.equal(Object.hasOwn(full.FieldNames, '__proto__'), true);
  assert.equal(full.FieldNames.__proto__, 'field-key');
  assert.equal(full.FieldNames.constructor, 'own-key');
  // The read must not write a key into the prototype chain.
  assert.equal(Object.hasOwn(Object.prototype, 'reviewMarker'), false);
  assert.equal(({} as Record<string, unknown>).reviewMarker, undefined);
  const masked = await api('GET', `/users/${student.id}`, {
    query: { projection: 'custom', customFieldMask: '__proto__' },
  });
  assert.equal(masked.status, 200);
  assert.deepEqual(Object.keys(masked.json().customSchemas), ['__proto__']);
  const listed = await api('GET', '/users', {
    query: { customer: 'my_customer', projection: 'full', maxResults: 500 },
  });
  const row = (
    listed.json().users as {
      id: string;
      customSchemas?: Record<string, unknown>;
    }[]
  ).find((user) => user.id === student.id)!;
  assert.equal(Object.hasOwn(row.customSchemas!, '__proto__'), true);
  assert.deepEqual(
    (row.customSchemas as Record<string, Record<string, unknown>>).__proto__,
    { reviewMarker: 'schema-key' },
  );
});

test('a bad date, a long email, and a bad entry type answer 400', async (t) => {
  const { values, patch } = await setup(t);
  const accepted = await patch({
    customSchemas: {
      StudentInfo: {
        HireDate: '2028-02-29',
        GuardianEmail: 'guardian@example.org',
        Programs: [
          { value: 'Band', type: 'work' },
          { value: 'ELL', type: 'home', customType: 'evening' },
          { value: 'Robotics', type: 'other' },
          { value: 'Yearbook', type: 'custom' },
        ],
      },
    },
  });
  assert.equal(accepted.status, 200);
  const before = await values();
  const cases: Record<string, unknown>[] = [
    { StudentInfo: { HireDate: '2026-02-31' } },
    { StudentInfo: { HireDate: '2026-13-01' } },
    { StudentInfo: { HireDate: '2026-02-29' } },
    { StudentInfo: { GuardianEmail: `${'a'.repeat(501)}@example.org` } },
    { StudentInfo: { Programs: [{ value: 'Band', type: 'arbitrary' }] } },
    { StudentInfo: { Programs: [{ value: 'Band', type: '' }] } },
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
  // A refusal leaves every stored value as it was.
  assert.deepEqual(await values(), before);
  const longest = `${'a'.repeat(488)}@example.org`;
  assert.equal([...longest].length, 500);
  const boundary = await patch({
    customSchemas: { StudentInfo: { GuardianEmail: longest } },
  });
  assert.equal(boundary.status, 200);
  assert.equal((await values())!.StudentInfo.GuardianEmail, longest);
});

test('a custom query accepts every legal schema name', async (t) => {
  const { api, student } = await setup(t);
  const names = ['_Info', '1Info', '-Info'];
  for (const name of names) {
    const created = await api('POST', '/customer/my_customer/schemas', {
      body: {
        schemaName: name,
        displayName: `Info ${name}`,
        fields: [
          { fieldName: 'Code', fieldType: 'STRING', displayName: 'Code' },
          {
            fieldName: 'Nickname',
            fieldType: 'STRING',
            displayName: 'Nickname',
            indexed: false,
          },
        ],
      },
    });
    assert.equal(created.status, 200, name);
    const written = await api('PATCH', `/users/${student.id}`, {
      body: { customSchemas: { [name]: { Code: 'S100' } } },
    });
    assert.equal(written.status, 200, name);
  }
  const search = async (query: string) => {
    const response = await api('GET', '/users', {
      query: { customer: 'my_customer', maxResults: 500, query },
    });
    assert.equal(response.status, 200, `${query}: ${response.text}`);
    return (response.json().users as { primaryEmail: string }[]).map(
      (user) => user.primaryEmail,
    );
  };
  for (const name of names)
    assert.deepEqual(await search(`${name}.Code=S100`), [
      student.primary_email,
    ]);
  for (const query of [
    '_Info.Missing=1',
    '1Info.Missing=1',
    '-Info.Missing=1',
    '_Info.Nickname=Ana',
    '1Info.Nickname=Ana',
    '-Info.Nickname=Ana',
  ]) {
    const response = await api('GET', '/users', {
      query: { customer: 'my_customer', query },
    });
    assert.equal(response.status, 400, query);
    assert.equal(response.json().error.errors[0].reason, 'invalid', query);
  }
});

test('a multi-value search compares one entry at a time', async (t) => {
  const { api, student, other, patch } = await setup(t);
  await patch({
    customSchemas: {
      StudentInfo: { Programs: [{ value: 'Band' }, { value: 'ELL' }] },
    },
  });
  await patch(
    { customSchemas: { StudentInfo: { Programs: [{ value: 'Band ELL' }] } } },
    other.id,
  );
  const search = async (query: string) => {
    const response = await api('GET', '/users', {
      query: { customer: 'my_customer', maxResults: 500, query },
    });
    assert.equal(response.status, 200, `${query}: ${response.text}`);
    return (response.json().users as { primaryEmail: string }[]).map(
      (user) => user.primaryEmail,
    );
  };
  assert.deepEqual(await search('StudentInfo.Programs=Band'), [
    student.primary_email,
  ]);
  assert.deepEqual(await search('StudentInfo.Programs=ELL'), [
    student.primary_email,
  ]);
  assert.deepEqual(await search("StudentInfo.Programs='Band ELL'"), [
    other.primary_email,
  ]);
  assert.deepEqual(await search('StudentInfo.Programs:B*'), [
    student.primary_email,
    other.primary_email,
  ]);
  // The phrase spans two separate entries of the first user, so it names neither.
  assert.deepEqual(await search("StudentInfo.Programs:'Band ELL'"), [
    other.primary_email,
  ]);
});

const REVIEW = {
  schemaName: 'ReviewInfo',
  displayName: 'Review information',
  fields: [
    { fieldName: 'Code', fieldType: 'STRING', displayName: 'Code' },
    { fieldName: 'Grade', fieldType: 'INT64', displayName: 'Grade' },
    { fieldName: 'Flag', fieldType: 'BOOL', displayName: 'Flag' },
  ],
};
const REVIEW_QUERIES = [
  'ReviewInfo.Code=S100',
  'ReviewInfo.Code:S1*',
  "ReviewInfo.Code:'S100'",
  'ReviewInfo.Grade=7',
  'ReviewInfo.Grade:7*',
  'ReviewInfo.Grade:7',
  'ReviewInfo.Flag=true',
  'ReviewInfo.Flag:true',
];

/** A user with one value of each type, a search helper, and the allowed widening. */
async function reviewSetup(t: import('node:test').TestContext) {
  const base = await setup(t);
  const created = await base.api('POST', '/customer/my_customer/schemas', {
    body: REVIEW,
  });
  assert.equal(created.status, 200);
  const written = await base.patch({
    customSchemas: { ReviewInfo: { Code: 'S100', Grade: 7, Flag: true } },
  });
  assert.equal(written.status, 200);
  const search = async (query: string) => {
    const response = await base.api('GET', '/users', {
      query: { customer: 'my_customer', maxResults: 500, query },
    });
    assert.equal(response.status, 200, `${query}: ${response.text}`);
    return ((response.json().users ?? []) as { primaryEmail: string }[]).map(
      (user) => user.primaryEmail,
    );
  };
  const narrow = async (query: string) =>
    assert.deepEqual(await search(query), [base.student.primary_email], query);
  const widen = async () => {
    const response = await base.api(
      'PUT',
      '/customer/my_customer/schemas/ReviewInfo',
      {
        body: {
          ...REVIEW,
          fields: REVIEW.fields.map((field) => ({
            ...field,
            multiValued: true,
          })),
        },
      },
    );
    assert.equal(response.status, 200);
  };
  return { ...base, search, narrow, widen };
}

test('a field that widens keeps its values in the entry form', async (t) => {
  const { api, student, values, narrow, widen } = await reviewSetup(t);
  for (const query of REVIEW_QUERIES) await narrow(query);
  await widen();
  // The value that a user wrote before the widening follows the entry form now.
  const full = (await values()) as Record<string, Record<string, unknown>>;
  assert.deepEqual(full.ReviewInfo, {
    Code: [{ value: 'S100' }],
    Grade: [{ value: 7 }],
    Flag: [{ value: true }],
  });
  const masked = await api('GET', `/users/${student.id}`, {
    query: { projection: 'custom', customFieldMask: 'ReviewInfo' },
  });
  assert.equal(masked.status, 200);
  assert.deepEqual(masked.json().customSchemas, {
    ReviewInfo: {
      Code: [{ value: 'S100' }],
      Grade: [{ value: 7 }],
      Flag: [{ value: true }],
    },
  });
});

test('a field that widens keeps its values searchable', async (t) => {
  const { patch, search, narrow, widen, student } = await reviewSetup(t);
  for (const query of REVIEW_QUERIES) await narrow(query);
  await widen();
  // Every query still finds the value, without a rewrite of the user's values.
  for (const query of REVIEW_QUERIES) await narrow(query);
  // A list replaces the widened value, and each entry is its own value.
  const listed = await patch({
    customSchemas: {
      ReviewInfo: { Code: [{ value: 'S200' }, { value: 'S300' }] },
    },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(await search('ReviewInfo.Code=S300'), [
    student.primary_email,
  ]);
  assert.deepEqual(await search('ReviewInfo.Code:S2*'), [
    student.primary_email,
  ]);
  assert.deepEqual(await search('ReviewInfo.Code=S100'), []);
});
