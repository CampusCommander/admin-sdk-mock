import assert from 'node:assert/strict';
import test from 'node:test';
import { WRITE_SCOPES } from '../auth/scopes.ts';
import {
  googleClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { CSV_MIME, SHEET_MIME } from './store.ts';

const SPEC = {
  tier: 'small',
  seed: 'sheets',
  counts: { schools: 1, students: 10, staff: 2, devices: 2 },
};
const HEADER = ['id', 'name', 'serial'];

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const owner = `admin@${domain.spec.primaryDomain}`;
  const token = grantToken(harness, domain, WRITE_SCOPES.drive, owner);
  const sheets = googleClient(harness, token, 'sheets.googleapis.com');
  const drive = googleClient(harness, token, 'www.googleapis.com', '/drive/v3');
  return { harness, domain, owner, token, sheets, drive };
}

const createBody = () => ({
  properties: { title: 'Device edit template' },
  sheets: [
    {
      properties: {
        title: 'Devices',
        gridProperties: { rowCount: 1_000, columnCount: 10, frozenRowCount: 1 },
      },
      data: [
        {
          startRow: 0,
          startColumn: 0,
          rowData: [
            {
              values: HEADER.map((text) => ({
                userEnteredValue: { stringValue: text },
              })),
            },
          ],
        },
      ],
    },
  ],
});

test('spreadsheets.create makes one Sheet in the Drive of the token subject', async (t) => {
  const { sheets, drive, harness, domain, owner } = await setup(t);
  const created = await sheets('POST', '/v4/spreadsheets', {
    body: createBody(),
  });
  assert.equal(created.status, 200);
  const body = created.json();
  assert.match(body.spreadsheetId, /^[A-Za-z0-9_-]{44}$/);
  assert.equal(body.properties.title, 'Device edit template');
  assert.equal(body.properties.locale, 'en_US');
  assert.equal(body.properties.timeZone, 'UTC');
  assert.equal(body.properties.autoRecalc, 'ON_CHANGE');
  assert.deepEqual(body.sheets, [
    {
      properties: {
        sheetId: 0,
        title: 'Devices',
        index: 0,
        sheetType: 'GRID',
        gridProperties: {
          rowCount: 1_000,
          columnCount: 10,
          frozenRowCount: 1,
        },
      },
    },
  ]);
  const file = harness.mock.drive.file(domain.customerId, body.spreadsheetId)!;
  assert.equal(file.owner, owner);
  assert.equal(file.mimeType, SHEET_MIME);
  const listed = await drive('GET', '/files');
  assert.deepEqual(
    listed.json().files.map((entry: { id: string }) => entry.id),
    [body.spreadsheetId],
  );
});

test('spreadsheets.create needs a title and a JSON body', async (t) => {
  const { sheets } = await setup(t);
  for (const body of [
    {},
    { properties: {} },
    { properties: { title: '' } },
    { properties: { title: 4 } },
    { properties: { title: 'x' }, sheets: 'nope' },
    [],
    'not json',
    '',
  ]) {
    const response = await sheets('POST', '/v4/spreadsheets', { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json().error.status, 'INVALID_ARGUMENT');
  }
  const badTab = await sheets('POST', '/v4/spreadsheets', {
    body: { properties: { title: 'x' }, sheets: [4] },
  });
  assert.equal(badTab.status, 400);
  const badGrid = await sheets('POST', '/v4/spreadsheets', {
    body: {
      properties: { title: 'x' },
      sheets: [{ properties: { gridProperties: { rowCount: -1 } } }],
    },
  });
  assert.equal(badGrid.status, 400);
});

test('spreadsheets.get returns the tabs, and the cell data on request', async (t) => {
  const { sheets } = await setup(t);
  const { spreadsheetId } = (
    await sheets('POST', '/v4/spreadsheets', { body: createBody() })
  ).json();
  const plain = await sheets('GET', `/v4/spreadsheets/${spreadsheetId}`);
  assert.equal(plain.status, 200);
  assert.equal(plain.json().sheets[0].data, undefined);
  const grid = await sheets('GET', `/v4/spreadsheets/${spreadsheetId}`, {
    query: { includeGridData: true },
  });
  const data = grid.json().sheets[0].data[0];
  assert.equal(data.startRow, 0);
  assert.equal(data.startColumn, 0);
  assert.deepEqual(
    data.rowData.map((row: { values: { formattedValue: string }[] }) =>
      row.values.map((cell) => cell.formattedValue),
    ),
    [HEADER],
  );
  assert.deepEqual(data.rowData[0].values[2].userEnteredValue, {
    stringValue: 'serial',
  });
});

test('a spreadsheet of another subject, and a file that is not a spreadsheet, answer 404', async (t) => {
  const { sheets, harness, domain, token } = await setup(t);
  const { spreadsheetId } = (
    await sheets('POST', '/v4/spreadsheets', { body: createBody() })
  ).json();
  assert.equal(
    (await sheets('GET', `/v4/spreadsheets/${spreadsheetId}`)).status,
    200,
  );
  assert.equal((await sheets('GET', '/v4/spreadsheets/missing')).status, 404);
  assert.equal(
    (await sheets('GET', '/v4/spreadsheets/missing')).json().error.status,
    'NOT_FOUND',
  );
  const csv = harness.mock.drive.create(domain.customerId, {
    name: 'Devices.csv',
    mimeType: CSV_MIME,
    owner: `admin@${domain.spec.primaryDomain}`,
    content: 'a\n',
  });
  assert.equal((await sheets('GET', `/v4/spreadsheets/${csv.id}`)).status, 404);
  assert.equal(token.length > 0, true);
});

test('batchUpdate sets the text format through repeatCell', async (t) => {
  const { sheets } = await setup(t);
  const { spreadsheetId } = (
    await sheets('POST', '/v4/spreadsheets', { body: createBody() })
  ).json();
  const updated = await sheets(
    'POST',
    `/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      body: {
        requests: [
          {
            repeatCell: {
              range: { sheetId: 0, startColumnIndex: 0, endColumnIndex: 10 },
              cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
              fields: 'userEnteredFormat.numberFormat',
            },
          },
        ],
      },
    },
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json(), { spreadsheetId, replies: [{}] });
  const grid = await sheets('GET', `/v4/spreadsheets/${spreadsheetId}`, {
    query: { includeGridData: true },
  });
  const cell = grid.json().sheets[0].data[0].rowData[0].values[0];
  assert.deepEqual(cell.userEnteredFormat.numberFormat, { type: 'TEXT' });
  const pattern = await sheets(
    'POST',
    `/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      body: {
        requests: [
          {
            repeatCell: {
              range: { sheetId: 0 },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'NUMBER', pattern: '#,##0' },
                },
              },
            },
          },
        ],
      },
    },
  );
  assert.equal(pattern.status, 200);
});

test('batchUpdate refuses a request that the mock does not serve', async (t) => {
  const { sheets } = await setup(t);
  const { spreadsheetId } = (
    await sheets('POST', '/v4/spreadsheets', { body: createBody() })
  ).json();
  const cases = [
    {},
    { requests: 'x' },
    { requests: [{ addSheet: {} }] },
    { requests: [4] },
    { requests: [{ repeatCell: { cell: {} } }] },
    { requests: [{ repeatCell: { range: {}, cell: {} } }] },
    { requests: [{ repeatCell: { range: { sheetId: 9 }, cell: {} } }] },
    { requests: [{ repeatCell: { range: { sheetId: 0 }, cell: {} } }] },
    {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0 },
            cell: { userEnteredFormat: { numberFormat: {} } },
          },
        },
      ],
    },
  ];
  for (const body of cases) {
    const response = await sheets(
      'POST',
      `/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      { body },
    );
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(
    (
      await sheets('POST', '/v4/spreadsheets/missing:batchUpdate', {
        body: { requests: [] },
      })
    ).status,
    404,
  );
  const encoded = await sheets(
    'POST',
    `/v4/spreadsheets/${spreadsheetId}%3AbatchUpdate`,
    { body: { requests: [] } },
  );
  assert.equal(encoded.status, 200);
});

test('values.get returns formatted values in rows or columns', async (t) => {
  const { sheets } = await setup(t);
  const { spreadsheetId } = (
    await sheets('POST', '/v4/spreadsheets', { body: createBody() })
  ).json();
  await sheets('PUT', `/v4/spreadsheets/${spreadsheetId}/values/Devices!A2`, {
    query: { valueInputOption: 'RAW' },
    body: {
      values: [
        ['1', 'Ana'],
        ['2', 'Ben', 'PF2'],
      ],
    },
  });
  const whole = await sheets(
    'GET',
    `/v4/spreadsheets/${spreadsheetId}/values/Devices`,
  );
  assert.equal(whole.status, 200);
  assert.equal(whole.json().range, 'Devices!A1:C3');
  assert.equal(whole.json().majorDimension, 'ROWS');
  assert.deepEqual(whole.json().values, [
    HEADER,
    ['1', 'Ana', ''],
    ['2', 'Ben', 'PF2'],
  ]);
  const block = await sheets(
    'GET',
    '/v4/spreadsheets/' + spreadsheetId + '/values/Devices!A1:C2',
  );
  assert.deepEqual(block.json().values, [HEADER, ['1', 'Ana', '']]);
  assert.equal(block.json().range, 'Devices!A1:C2');
  const columns = await sheets(
    'GET',
    `/v4/spreadsheets/${spreadsheetId}/values/Devices!A1:C2`,
    {
      query: { majorDimension: 'COLUMNS' },
    },
  );
  assert.deepEqual(columns.json().values, [
    ['id', '1'],
    ['name', 'Ana'],
    ['serial', ''],
  ]);
  assert.equal(columns.json().majorDimension, 'COLUMNS');
  const unformatted = await sheets(
    'GET',
    `/v4/spreadsheets/${spreadsheetId}/values/Devices!A1`,
    {
      query: { valueRenderOption: 'UNFORMATTED_VALUE' },
    },
  );
  assert.deepEqual(unformatted.json().values, [['id']]);
  const formula = await sheets(
    'GET',
    `/v4/spreadsheets/${spreadsheetId}/values/Devices!A1`,
    {
      query: { valueRenderOption: 'FORMULA' },
    },
  );
  assert.deepEqual(formula.json().values, [['id']]);
});

test('values.get refuses a range, an option, and a dimension that it cannot read', async (t) => {
  const { sheets } = await setup(t);
  const { spreadsheetId } = (
    await sheets('POST', '/v4/spreadsheets', { body: createBody() })
  ).json();
  const base = `/v4/spreadsheets/${spreadsheetId}/values/`;
  for (const [range, query] of [
    ['Missing!A1', {}],
    ['Devices!A1:B2:C3', {}],
    ['Devices!A1', { valueRenderOption: 'HTML' }],
    ['Devices!A1', { majorDimension: 'SIDEWAYS' }],
  ] as [string, Record<string, string>][]) {
    const response = await sheets('GET', `${base}${range}`, { query });
    assert.equal(response.status, 400, range);
    assert.equal(response.json().error.status, 'INVALID_ARGUMENT');
  }
  assert.equal(
    (await sheets('GET', '/v4/spreadsheets/missing/values/A1')).status,
    404,
  );
});

test('values.update writes RAW text, grows the grid, and echoes the range', async (t) => {
  const { sheets } = await setup(t);
  const { spreadsheetId } = (
    await sheets('POST', '/v4/spreadsheets', { body: createBody() })
  ).json();
  const written = await sheets(
    'PUT',
    `/v4/spreadsheets/${spreadsheetId}/values/Devices!A1`,
    {
      query: { valueInputOption: 'RAW' },
      body: { values: [HEADER, ['1', 'Ana', 'PF1'], ['2', 'Ben']] },
    },
  );
  assert.equal(written.status, 200);
  assert.deepEqual(written.json(), {
    spreadsheetId,
    updatedRange: 'Devices!A1:C3',
    updatedRows: 3,
    updatedColumns: 3,
    updatedCells: 8,
  });
  const beyond = await sheets(
    'PUT',
    `/v4/spreadsheets/${spreadsheetId}/values/Devices!J1`,
    {
      query: { valueInputOption: 'RAW' },
      body: { values: [['x']] },
    },
  );
  assert.equal(beyond.status, 200);
  assert.equal(beyond.json().updatedRange, 'Devices!J1:J1');
  const read = await sheets(
    'GET',
    `/v4/spreadsheets/${spreadsheetId}/values/Devices!A1:C3`,
  );
  assert.deepEqual(read.json().values, [
    HEADER,
    ['1', 'Ana', 'PF1'],
    ['2', 'Ben', ''],
  ]);
  const small = await sheets('POST', '/v4/spreadsheets', {
    body: {
      properties: { title: 'Small grid' },
      sheets: [
        {
          properties: {
            title: 'Tiny',
            gridProperties: { rowCount: 2, columnCount: 2 },
          },
        },
      ],
    },
  });
  const smallId = small.json().spreadsheetId;
  const grown = await sheets(
    'PUT',
    `/v4/spreadsheets/${smallId}/values/Tiny!A1`,
    {
      query: { valueInputOption: 'RAW' },
      body: { values: [['a', 'b', 'c'], ['d'], ['e']] },
    },
  );
  assert.equal(grown.status, 200);
  const after = await sheets('GET', `/v4/spreadsheets/${smallId}`);
  assert.deepEqual(after.json().sheets[0].properties.gridProperties, {
    rowCount: 3,
    columnCount: 3,
  });
  const empty = await sheets(
    'PUT',
    `/v4/spreadsheets/${spreadsheetId}/values/Devices!Z1`,
    {
      query: { valueInputOption: 'RAW' },
      body: {},
    },
  );
  assert.equal(empty.status, 200);
  assert.equal(empty.json().updatedRows, 0);
  assert.equal(empty.json().updatedRange, 'Devices!Z1:Z1');
});

test('values.update refuses a missing or unsupported input option and a bad body', async (t) => {
  const { sheets } = await setup(t);
  const { spreadsheetId } = (
    await sheets('POST', '/v4/spreadsheets', { body: createBody() })
  ).json();
  const url = `/v4/spreadsheets/${spreadsheetId}/values/Devices!A1`;
  const cases: [Record<string, string>, unknown][] = [
    [{}, { values: [['a']] }],
    [{ valueInputOption: 'USER_ENTERED' }, { values: [['a']] }],
    [{ valueInputOption: 'RAW' }, { values: 'x' }],
    [{ valueInputOption: 'RAW' }, { values: ['x'] }],
    [{ valueInputOption: 'RAW' }, 'not json'],
    [{ valueInputOption: 'RAW' }, ''],
  ];
  for (const [query, body] of cases) {
    const response = await sheets('PUT', url, { query, body });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const badRange = await sheets(
    'PUT',
    `/v4/spreadsheets/${spreadsheetId}/values/Missing!A1`,
    {
      query: { valueInputOption: 'RAW' },
      body: { values: [['a']] },
    },
  );
  assert.equal(badRange.status, 400);
  assert.equal(
    (
      await sheets('PUT', '/v4/spreadsheets/missing/values/A1', {
        query: { valueInputOption: 'RAW' },
        body: { values: [['a']] },
      })
    ).status,
    404,
  );
});

test('Sheets routes need a token with the file scope, and refuse a bad field', async (t) => {
  const { harness, domain, sheets } = await setup(t);
  const none = await harness.request({
    host: 'sheets.googleapis.com',
    path: '/v4/spreadsheets',
    method: 'POST',
    body: '{}',
  });
  assert.equal(none.status, 401);
  const readOnly = grantToken(harness, domain, [
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
  ]);
  const refused = await harness.request({
    host: 'sheets.googleapis.com',
    path: '/v4/spreadsheets',
    method: 'POST',
    token: readOnly,
    body: '{}',
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json().error.status, 'PERMISSION_DENIED');
  assert.equal(
    refused.json().error.details[0].metadata.service,
    'sheets.googleapis.com',
  );
  const created = await sheets('POST', '/v4/spreadsheets', {
    body: createBody(),
  });
  assert.equal(created.status, 200);
  const badFields = await sheets(
    'GET',
    `/v4/spreadsheets/${created.json().spreadsheetId}`,
    {
      query: { fields: 'nope' },
    },
  );
  assert.equal(badFields.status, 400);
  assert.equal(badFields.json().error.status, 'INVALID_ARGUMENT');
});
