import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { faultTargets } from '../routes.ts';
import { row } from '../store/sqlite.ts';
import { batchBody, batchStatuses } from '../testing/batch.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const P = 'https://www.googleapis.com/auth/';
const SCHEMA_READ = [`${P}admin.directory.userschema.readonly`];
const SCHEMA_WRITE = [`${P}admin.directory.userschema`];
const USER_READ = [`${P}admin.directory.user.readonly`];
const SPEC = {
  tier: 'small',
  seed: 'schemas',
  counts: { schools: 1, students: 12, staff: 3, devices: 5 },
};
const SCHEMA_ROUTES = [
  'directory.schemas.delete',
  'directory.schemas.get',
  'directory.schemas.insert',
  'directory.schemas.list',
  'directory.schemas.update',
];

/** A schema body with one field of each kind that the scenario uses. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    schemaName: 'StudentInfo',
    displayName: 'Student information',
    fields: [
      {
        fieldName: 'StudentID',
        fieldType: 'STRING',
        displayName: 'Student ID',
      },
      {
        fieldName: 'GradeLevel',
        fieldType: 'INT64',
        displayName: 'Grade level',
        numericIndexingSpec: { minValue: 0, maxValue: 12 },
      },
      {
        fieldName: 'Programs',
        fieldType: 'STRING',
        displayName: 'Programs',
        multiValued: true,
      },
    ],
    ...overrides,
  };
}

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const as = (scopes: readonly string[]) => {
    const api = directoryClient(harness, grantToken(harness, domain, scopes));
    return (
      method: string,
      path = '',
      options: Parameters<typeof api>[2] = {},
    ) => api(method, `/customer/my_customer/schemas${path}`, options);
  };
  const read = as(SCHEMA_READ);
  const write = as(SCHEMA_WRITE);
  const user = as(USER_READ);
  return { harness, domain, read, write, user };
}

test('the schema reads accept either userschema scope', async (t) => {
  const { read, write, user } = await setup(t);
  assert.equal((await read('GET')).status, 200);
  assert.equal((await write('GET')).status, 200);
  assert.equal((await read('GET', '/StudentInfo')).status, 404);
  const refused = await user('GET');
  assert.equal(refused.status, 403);
  assert.equal(
    refused.json().error.errors[0].reason,
    'insufficientPermissions',
  );
});

test('the schema writes need the write scope', async (t) => {
  const { read, user } = await setup(t);
  for (const [client, method] of [
    [read, 'POST'],
    [user, 'POST'],
    [read, 'PUT'],
    [read, 'DELETE'],
  ] as const) {
    const response = await client(
      method,
      method === 'POST' ? '' : '/StudentInfo',
      {
        body: method === 'DELETE' ? undefined : body(),
      },
    );
    assert.equal(response.status, 403, method);
  }
});

test('insert returns the resource with the mock IDs and the field defaults', async (t) => {
  const { write } = await setup(t);
  const response = await write('POST', '', { body: body() });
  assert.equal(response.status, 200);
  const schema = response.json();
  assert.equal(schema.kind, 'admin#directory#schema');
  assert.equal(schema.schemaName, 'StudentInfo');
  assert.equal(schema.displayName, 'Student information');
  assert.match(schema.schemaId, /^[A-Za-z0-9]{22}==$/);
  assert.match(schema.etag, /^".+"$/);
  assert.deepEqual(
    schema.fields.map(
      (field: {
        fieldName: string;
        multiValued: boolean;
        indexed: boolean;
        readAccessType: string;
        kind: string;
      }) => [
        field.fieldName,
        field.multiValued,
        field.indexed,
        field.readAccessType,
        field.kind,
      ],
    ),
    [
      [
        'StudentID',
        false,
        true,
        'ALL_DOMAIN_USERS',
        'admin#directory#schema#fieldspec',
      ],
      [
        'GradeLevel',
        false,
        true,
        'ALL_DOMAIN_USERS',
        'admin#directory#schema#fieldspec',
      ],
      [
        'Programs',
        true,
        true,
        'ALL_DOMAIN_USERS',
        'admin#directory#schema#fieldspec',
      ],
    ],
  );
  assert.deepEqual(schema.fields[1].numericIndexingSpec, {
    minValue: 0,
    maxValue: 12,
  });
  for (const field of schema.fields) {
    assert.match(field.fieldId, /^[A-Za-z0-9_-]{4,}$/);
    assert.match(field.etag, /^".+"$/);
  }
});

test('get reads a schema by its ID or by its name', async (t) => {
  const { read, write } = await setup(t);
  const inserted = (await write('POST', '', { body: body() })).json();
  const byName = await read('GET', '/StudentInfo');
  assert.equal(byName.status, 200);
  assert.equal(byName.json().schemaId, inserted.schemaId);
  const byId = await read('GET', `/${inserted.schemaId}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.json().schemaName, 'StudentInfo');
  const byEncoded = await read(
    'GET',
    `/${encodeURIComponent(inserted.schemaId)}`,
  );
  assert.equal(byEncoded.status, 200);
  assert.equal(byEncoded.json().schemaId, inserted.schemaId);
  const list = await read('GET');
  assert.equal(list.status, 200);
  assert.equal(list.json().kind, 'admin#directory#schemas');
  assert.equal(list.json().schemas.length, 1);
  assert.equal(list.json().schemas[0].schemaId, inserted.schemaId);
});

test('get, update, and delete accept the raw ID, the encoded ID, and the name', async (t) => {
  const { read, write } = await setup(t);
  let ordinal = 0;
  const create = async () => {
    const schemaName = `Key${ordinal++}`;
    const response = await write('POST', '', {
      body: body({
        schemaName,
        fields: [
          { fieldName: 'Field', fieldType: 'STRING', displayName: 'Field' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    return { schemaName, schemaId: response.json().schemaId as string };
  };
  for (const form of ['raw', 'encoded', 'name'] as const) {
    const schema = await create();
    const key =
      form === 'raw'
        ? schema.schemaId
        : form === 'encoded'
          ? encodeURIComponent(schema.schemaId)
          : schema.schemaName;
    const got = await read('GET', `/${key}`);
    assert.equal(got.status, 200, `get by ${form}`);
    assert.equal(got.json().schemaId, schema.schemaId, `get by ${form}`);
    const updated = await write('PUT', `/${key}`, {
      body: body({
        schemaName: schema.schemaName,
        displayName: `Updated by ${form}`,
        fields: [
          { fieldName: 'Field', fieldType: 'STRING', displayName: 'Field' },
        ],
      }),
    });
    assert.equal(updated.status, 200, `update by ${form}`);
    assert.equal(updated.json().displayName, `Updated by ${form}`);
    const deleted = await write('DELETE', `/${key}`);
    assert.equal(deleted.status, 204, `delete by ${form}`);
    assert.equal((await read('GET', `/${schema.schemaId}`)).status, 404);
  }
});

test('a schema key resolves by raw ID and encoded ID in a batch part', async (t) => {
  const { harness, domain, write } = await setup(t);
  const created = (await write('POST', '', { body: body() })).json();
  const token = grantToken(harness, domain, [...SCHEMA_READ, ...SCHEMA_WRITE]);
  const prefix = `/admin/directory/v1/customer/${domain.customerId}/schemas`;
  const encoded = encodeURIComponent(created.schemaId);
  const response = await harness.request({
    host: 'www.googleapis.com',
    path: '/batch/admin/directory_v1',
    method: 'POST',
    token,
    headers: { 'content-type': 'multipart/mixed; boundary=b' },
    body: batchBody(
      [
        { id: 'raw', method: 'GET', path: `${prefix}/${created.schemaId}` },
        { id: 'encoded', method: 'GET', path: `${prefix}/${encoded}` },
        {
          id: 'update',
          method: 'PUT',
          path: `${prefix}/${encoded}`,
          body: body({ displayName: 'Batch update' }),
        },
      ],
      'b',
    ),
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...batchStatuses(response.text).entries()].sort(), [
    ['encoded', 200],
    ['raw', 200],
    ['update', 200],
  ]);
  const deleted = await harness.request({
    host: 'www.googleapis.com',
    path: '/batch/admin/directory_v1',
    method: 'POST',
    token,
    headers: { 'content-type': 'multipart/mixed; boundary=b' },
    body: batchBody(
      [
        {
          id: 'delete',
          method: 'DELETE',
          path: `${prefix}/${created.schemaId}`,
        },
      ],
      'b',
    ),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    [...batchStatuses(deleted.text).entries()],
    [['delete', 204]],
  );
});

test('a reused schema name answers 412, and another name still inserts', async (t) => {
  const { harness, domain, write } = await setup(t);
  assert.equal((await write('POST', '', { body: body() })).status, 200);
  const again = await write('POST', '', {
    body: body({ displayName: 'Other' }),
  });
  assert.equal(again.status, 412);
  assert.equal(again.json().error.errors[0].reason, 'conditionNotMet');
  assert.equal(again.json().error.status, 'FAILED_PRECONDITION');
  const token = grantToken(harness, domain, [...SCHEMA_READ, ...SCHEMA_WRITE]);
  const prefix = `/admin/directory/v1/customer/${domain.customerId}/schemas`;
  const response = await harness.request({
    host: 'www.googleapis.com',
    path: '/batch/admin/directory_v1',
    method: 'POST',
    token,
    headers: { 'content-type': 'multipart/mixed; boundary=b' },
    body: batchBody(
      [
        { id: 'reused', method: 'POST', path: prefix, body: body() },
        {
          id: 'fresh',
          method: 'POST',
          path: prefix,
          body: body({ schemaName: 'StaffInfo' }),
        },
      ],
      'b',
    ),
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...batchStatuses(response.text).entries()].sort(), [
    ['fresh', 200],
    ['reused', 412],
  ]);
});

test('a bad name, a missing key, or a bad field answers 400', async (t) => {
  const { write } = await setup(t);
  const cases: Record<string, unknown>[] = [
    body({ schemaName: 'Student Info' }),
    body({ schemaName: '' }),
    body({ displayName: undefined }),
    body({ fields: undefined }),
    body({ fields: [] }),
    body({ fields: [{ fieldName: 'Grade', displayName: 'Grade' }] }),
    body({
      fields: [
        { fieldName: 'Grade', fieldType: 'NUMBER', displayName: 'Grade' },
      ],
    }),
    body({
      fields: [
        { fieldName: 'Grade', fieldType: 'INT64', displayName: 'Grade' },
        {
          fieldName: 'Grade',
          fieldType: 'INT64',
          displayName: 'Grade again',
        },
      ],
    }),
    body({
      fields: [
        {
          fieldName: 'Grade',
          fieldType: 'INT64',
          displayName: 'Grade',
          readAccessType: 'EVERYONE',
        },
      ],
    }),
    body({
      fields: [
        {
          fieldName: 'Grade',
          fieldType: 'INT64',
          displayName: 'Grade',
          numericIndexingSpec: { minValue: 12, maxValue: 0 },
        },
      ],
    }),
  ];
  for (const [index, input] of cases.entries()) {
    const response = await write('POST', '', { body: input });
    assert.equal(response.status, 400, `case ${index}`);
    assert.equal(
      response.json().error.errors[0].reason,
      'invalid',
      `case ${index}`,
    );
  }
});

test('a schema display name of 200 characters answers 400, and 21 characters is accepted', async (t) => {
  const { read, write } = await setup(t);
  const tooLong = 'D'.repeat(200);
  const refusedInsert = await write('POST', '', {
    body: body({ displayName: tooLong }),
  });
  assert.equal(refusedInsert.status, 400);
  assert.equal(refusedInsert.json().error.errors[0].reason, 'invalid');
  assert.deepEqual((await read('GET')).json().schemas, []);
  const displayName = 'D'.repeat(21);
  const created = await write('POST', '', { body: body({ displayName }) });
  assert.equal(created.status, 200);
  const refusedUpdate = await write('PUT', '/StudentInfo', {
    body: body({ displayName: tooLong }),
  });
  assert.equal(refusedUpdate.status, 400);
  assert.equal(refusedUpdate.json().error.errors[0].reason, 'invalid');
  assert.equal(
    (await read('GET', '/StudentInfo')).json().displayName,
    displayName,
  );
  // The limit applies to the schema, so a 200-character field display name passes.
  const field = await write('PUT', '/StudentInfo', {
    body: body({
      displayName,
      fields: [
        {
          fieldName: 'Field',
          fieldType: 'STRING',
          displayName: 'F'.repeat(200),
        },
      ],
    }),
  });
  assert.equal(field.status, 200);
  assert.equal(field.json().fields[0].displayName, 'F'.repeat(200));
});

test('an update gives the schema a new etag and keeps the field IDs', async (t) => {
  const { read, write } = await setup(t);
  const inserted = (await write('POST', '', { body: body() })).json();
  const kept = inserted.fields[0];
  const updated = await write('PUT', '/StudentInfo', {
    body: {
      schemaName: 'StudentInfo',
      displayName: 'Student records',
      fields: [
        {
          fieldId: kept.fieldId,
          fieldName: 'StudentID',
          fieldType: 'STRING',
          displayName: 'Student identifier',
        },
        { fieldName: 'Homeroom', fieldType: 'STRING', displayName: 'Homeroom' },
      ],
    },
  });
  assert.equal(updated.status, 200);
  const schema = updated.json();
  assert.equal(schema.displayName, 'Student records');
  assert.notEqual(schema.etag, inserted.etag);
  assert.equal(schema.schemaId, inserted.schemaId);
  assert.deepEqual(
    schema.fields.map((field: { fieldName: string; fieldId: string }) => [
      field.fieldName,
      field.fieldId,
    ]),
    [
      ['StudentID', kept.fieldId],
      ['Homeroom', schema.fields[1].fieldId],
    ],
  );
  assert.match(schema.fields[1].fieldId, /^[A-Za-z0-9_-]{4,}$/);
  assert.notEqual(schema.fields[1].fieldId, kept.fieldId);
  const reread = await read('GET', '/StudentInfo');
  assert.equal(reread.json().fields.length, 2);
});

test('the locks answer 400', async (t) => {
  const { read, write } = await setup(t);
  const inserted = (await write('POST', '', { body: body() })).json();
  const fields = inserted.fields as {
    fieldId: string;
    fieldName: string;
  }[];
  const rename = await write('PUT', '/StudentInfo', {
    body: { ...body(), schemaName: 'Renamed' },
  });
  assert.equal(rename.status, 400);
  const retype = await write('PUT', '/StudentInfo', {
    body: {
      ...body(),
      fields: [
        {
          fieldId: fields[0].fieldId,
          fieldName: 'StudentID',
          fieldType: 'INT64',
          displayName: 'Student ID',
        },
        {
          fieldId: fields[2].fieldId,
          fieldName: 'Programs',
          fieldType: 'STRING',
          displayName: 'Programs',
          multiValued: true,
        },
      ],
    },
  });
  assert.equal(retype.status, 400);
  const collapse = await write('PUT', '/StudentInfo', {
    body: {
      ...body(),
      fields: [
        {
          fieldId: fields[0].fieldId,
          fieldName: 'StudentID',
          fieldType: 'STRING',
          displayName: 'Student ID',
        },
        {
          fieldId: fields[2].fieldId,
          fieldName: 'Programs',
          fieldType: 'STRING',
          displayName: 'Programs',
        },
      ],
    },
  });
  assert.equal(collapse.status, 400);
  const kept = await read('GET', '/StudentInfo');
  assert.equal(kept.json().fields.length, 3);
  assert.equal(kept.json().schemaName, 'StudentInfo');
});

test('a field rename with its own ID answers 400', async (t) => {
  const { read, write } = await setup(t);
  const inserted = (await write('POST', '', { body: body() })).json();
  const first = inserted.fields[0] as { fieldId: string; fieldName: string };
  const renamed = await write('PUT', '/StudentInfo', {
    body: {
      schemaName: 'StudentInfo',
      displayName: 'Student information',
      fields: [
        {
          fieldId: first.fieldId,
          fieldName: 'LearnerID',
          fieldType: 'STRING',
          displayName: 'Student ID',
        },
        { fieldName: 'Homeroom', fieldType: 'STRING', displayName: 'Homeroom' },
      ],
    },
  });
  assert.equal(renamed.status, 400);
  assert.equal(renamed.json().error.errors[0].reason, 'invalid');
  const unchanged = await read('GET', '/StudentInfo');
  assert.equal(unchanged.json().fields.length, 3);
  assert.equal(
    unchanged
      .json()
      .fields.find(
        (field: { fieldId: string }) => field.fieldId === first.fieldId,
      ).fieldName,
    'StudentID',
  );
});

test('a single-valued field may become multi-valued', async (t) => {
  const { read, write } = await setup(t);
  const inserted = (await write('POST', '', { body: body() })).json();
  const first = inserted.fields[0] as { fieldId: string };
  const widened = await write('PUT', '/StudentInfo', {
    body: {
      schemaName: 'StudentInfo',
      displayName: 'Student information',
      fields: [
        {
          fieldId: first.fieldId,
          fieldName: 'StudentID',
          fieldType: 'STRING',
          displayName: 'Student ID',
          multiValued: true,
        },
        {
          fieldName: 'GradeLevel',
          fieldType: 'INT64',
          displayName: 'Grade level',
          numericIndexingSpec: { minValue: 0, maxValue: 12 },
        },
        {
          fieldName: 'Programs',
          fieldType: 'STRING',
          displayName: 'Programs',
          multiValued: true,
        },
      ],
    },
  });
  assert.equal(widened.status, 200);
  const schema = widened.json();
  const field = schema.fields.find(
    (entry: { fieldName: string }) => entry.fieldName === 'StudentID',
  );
  assert.equal(field.multiValued, true);
  assert.equal(field.fieldId, first.fieldId);
  assert.notEqual(schema.etag, inserted.etag);
  const reread = await read('GET', '/StudentInfo');
  assert.equal(
    reread
      .json()
      .fields.find(
        (entry: { fieldName: string }) => entry.fieldName === 'StudentID',
      ).multiValued,
    true,
  );
});

test('a customer holds at most 100 schemas', async (t) => {
  const { read, write } = await setup(t);
  for (let index = 0; index < 100; index++) {
    const response = await write('POST', '', {
      body: body({
        schemaName: `Schema${index}`,
        fields: [
          { fieldName: 'Field', fieldType: 'STRING', displayName: 'Field' },
        ],
      }),
    });
    assert.equal(response.status, 200, `schema ${index}`);
  }
  const refused = await write('POST', '', {
    body: body({
      schemaName: 'OneTooMany',
      fields: [
        { fieldName: 'Field', fieldType: 'STRING', displayName: 'Field' },
      ],
    }),
  });
  assert.equal(refused.status, 400);
  assert.equal((await read('GET')).json().schemas.length, 100);
});

test('a customer holds at most 100 fields', async (t) => {
  const { read, write } = await setup(t);
  const fields = Array.from({ length: 100 }, (_, index) => ({
    fieldName: `Field${index}`,
    fieldType: 'STRING',
    displayName: `Field ${index}`,
  }));
  const full = await write('POST', '', { body: body({ fields }) });
  assert.equal(full.status, 200);
  const added = await write('PUT', '/StudentInfo', {
    body: {
      schemaName: 'StudentInfo',
      displayName: 'Student information',
      fields: [
        ...fields,
        { fieldName: 'OneTooMany', fieldType: 'STRING', displayName: 'One' },
      ],
    },
  });
  assert.equal(added.status, 400);
  assert.equal((await read('GET', '/StudentInfo')).json().fields.length, 100);
  const second = await write('POST', '', {
    body: body({
      schemaName: 'Second',
      fields: [
        { fieldName: 'Field', fieldType: 'STRING', displayName: 'Field' },
      ],
    }),
  });
  assert.equal(second.status, 400);
});

test('an update applies whatever If-Match holds and answers a new etag', async (t) => {
  const { read, write } = await setup(t);
  const inserted = (await write('POST', '', { body: body() })).json();
  const stale = await write('PUT', `/${inserted.schemaId}`, {
    body: body({ displayName: 'Changed' }),
    headers: { 'if-match': '"stale"' },
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.json().displayName, 'Changed');
  assert.notEqual(stale.json().etag, inserted.etag);
  assert.equal(
    (await read('GET', '/StudentInfo')).json().displayName,
    'Changed',
  );
});

test('a stale If-Match on a delete answers 412 and keeps the schema', async (t) => {
  const { read, write } = await setup(t);
  const inserted = (await write('POST', '', { body: body() })).json();
  const refused = await write('DELETE', '/StudentInfo', {
    headers: { 'if-match': '"stale"' },
  });
  assert.equal(refused.status, 412);
  assert.equal(refused.json().error.errors[0].reason, 'conditionNotMet');
  assert.equal(refused.json().error.status, 'FAILED_PRECONDITION');
  assert.equal((await read('GET', '/StudentInfo')).status, 200);
  const fresh = await write('DELETE', '/StudentInfo', {
    headers: { 'if-match': inserted.etag },
  });
  assert.equal(fresh.status, 204);
});

test('a delete answers 204 and removes the schema', async (t) => {
  const { read, write } = await setup(t);
  const inserted = (await write('POST', '', { body: body() })).json();
  const deleted = await write('DELETE', `/${inserted.schemaId}`);
  assert.equal(deleted.status, 204);
  assert.equal((await read('GET', '/StudentInfo')).status, 404);
  assert.deepEqual((await read('GET')).json().schemas, []);
});

test('an unknown schema answers 404', async (t) => {
  const { read, write } = await setup(t);
  for (const response of [
    await read('GET', '/Missing'),
    await write('PUT', '/Missing', { body: body() }),
    await write('DELETE', '/Missing'),
  ]) {
    assert.equal(response.status, 404);
    assert.equal(response.json().error.errors[0].reason, 'notFound');
    assert.match(response.json().error.message, /Resource Not Found/);
  }
});

test('each schema route runs as a batch part', async (t) => {
  const { harness, domain } = await setup(t);
  const token = grantToken(harness, domain, [...SCHEMA_READ, ...SCHEMA_WRITE]);
  const prefix = `/admin/directory/v1/customer/${domain.customerId}/schemas`;
  const created = await harness.request({
    host: 'admin.googleapis.com',
    method: 'POST',
    path: prefix,
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body()),
  });
  assert.equal(created.status, 200);
  const response = await harness.request({
    host: 'www.googleapis.com',
    path: '/batch/admin/directory_v1',
    method: 'POST',
    token,
    headers: { 'content-type': 'multipart/mixed; boundary=b' },
    body: batchBody(
      [
        { id: 'list', method: 'GET', path: prefix },
        { id: 'get', method: 'GET', path: `${prefix}/StudentInfo` },
        {
          id: 'insert',
          method: 'POST',
          path: prefix,
          body: body({ schemaName: 'StaffInfo' }),
        },
        {
          id: 'update',
          method: 'PUT',
          path: `${prefix}/StaffInfo`,
          body: body({ schemaName: 'StaffInfo', displayName: 'Staff records' }),
        },
        { id: 'delete', method: 'DELETE', path: `${prefix}/StaffInfo` },
      ],
      'b',
    ),
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...batchStatuses(response.text).entries()].sort(), [
    ['delete', 204],
    ['get', 200],
    ['insert', 200],
    ['list', 200],
    ['update', 200],
  ]);
});

test('a refused first custom write leaves the domain usable', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const student = row<{ id: string }>(
    domain.db
      .prepare(
        "SELECT id FROM users WHERE role = 'student' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!;
  assert.equal(
    row(
      domain.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_schemas'",
        )
        .get(),
    ),
    undefined,
  );
  const refused = await api('PATCH', `/users/${student.id}`, {
    body: { customSchemas: { Missing: { Code: 'S100' } } },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().error.errors[0].reason, 'invalid');
  // The rolled-back tables are gone, so the reads answer as a domain of 0.3.0.
  const read = await api('GET', `/users/${student.id}`, {
    query: { projection: 'full' },
  });
  assert.equal(read.status, 200);
  assert.equal(Object.hasOwn(read.json(), 'customSchemas'), false);
  const list = await api('GET', '/customer/my_customer/schemas');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json().schemas, []);
  const created = await api('POST', '/customer/my_customer/schemas', {
    body: body(),
  });
  assert.equal(created.status, 200);
  assert.equal(
    (await api('GET', '/customer/my_customer/schemas/StudentInfo')).status,
    200,
  );
  const written = await api('PATCH', `/users/${student.id}`, {
    body: { customSchemas: { StudentInfo: { StudentID: 'S200' } } },
  });
  assert.equal(written.status, 200);
});

test('a recreated schema gets a new ID and a new etag', async (t) => {
  const { read, write } = await setup(t);
  const first = (await write('POST', '', { body: body() })).json();
  assert.equal((await write('DELETE', '/StudentInfo')).status, 204);
  const second = (
    await write('POST', '', {
      body: body({ displayName: 'Student information again' }),
    })
  ).json();
  assert.notEqual(second.schemaId, first.schemaId);
  assert.match(second.schemaId, /^[A-Za-z0-9]{22}==$/);
  assert.notEqual(second.etag, first.etag);
  for (const [index, field] of second.fields.entries())
    assert.notEqual(field.fieldId, first.fields[index].fieldId);
  // The old ID names nothing, and the old etag cannot delete the replacement.
  assert.equal((await read('GET', `/${first.schemaId}`)).status, 404);
  const stale = await write('DELETE', '/StudentInfo', {
    headers: { 'if-match': first.etag },
  });
  assert.equal(stale.status, 412);
  const updated = await write('PUT', '/StudentInfo', {
    body: body({ displayName: 'Third name' }),
    headers: { 'if-match': first.etag },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json().schemaId, second.schemaId);
  assert.equal(updated.json().displayName, 'Third name');
  assert.notEqual(updated.json().etag, second.etag);
  const live = await read('GET', '/StudentInfo');
  assert.equal(live.status, 200);
  assert.equal(live.json().schemaId, second.schemaId);
  assert.equal(live.json().displayName, 'Third name');
});

test('a schema named like a prototype key round-trips through every route', async (t) => {
  const { read, write } = await setup(t);
  const created = await write('POST', '', {
    body: {
      schemaName: '__proto__',
      displayName: 'Prototype names',
      fields: [
        { fieldName: 'reviewMarker', fieldType: 'STRING', displayName: 'Mark' },
      ],
    },
  });
  assert.equal(created.status, 200);
  const list = await read('GET');
  assert.equal(list.status, 200);
  assert.deepEqual(
    list
      .json()
      .schemas.map((schema: { schemaName: string }) => schema.schemaName),
    ['__proto__'],
  );
  const got = await read('GET', '/__proto__');
  assert.equal(got.status, 200);
  assert.equal(got.json().schemaName, '__proto__');
});

test('each schema route is a fault target, and a status fault names the route', async (t) => {
  const { harness, domain, read, write } = await setup(t);
  assert.deepEqual(
    faultTargets(harness.mock.routes)
      .filter((id) => SCHEMA_ROUTES.includes(id))
      .sort(),
    SCHEMA_ROUTES,
  );
  harness.mock.faults.add(domain.customerId, {
    kind: 'status',
    method: 'directory.schemas.insert',
    status: 500,
    reason: 'backendError',
    count: 1,
  });
  const failed = await write('POST', '', { body: body() });
  assert.equal(failed.status, 500);
  assert.equal(failed.json().error.message, 'Backend Error');
  assert.deepEqual((await read('GET')).json().schemas, []);
  assert.equal((await write('POST', '', { body: body() })).status, 200);
});
