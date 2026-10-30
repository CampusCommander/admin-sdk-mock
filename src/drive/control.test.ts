import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { issueServiceAccount } from '../auth/accounts.ts';
import { SCOPE_PREFIX } from '../auth/scopes.ts';
import { createControlHandler } from '../control/control.ts';
import { row } from '../store/sqlite.ts';
import {
  googleClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { signAssertion, tokenRequestBody } from '../testing/jwt.ts';
import { CSV_MIME, SHEET_MIME } from './store.ts';

const SPEC = {
  tier: 'small',
  seed: 'drive-control',
  counts: { schools: 1, students: 10, staff: 2, devices: 2 },
};
const DRIVE_SCOPE = `${SCOPE_PREFIX}drive.file`;

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  const server = http.createServer(createControlHandler(harness.mock));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await harness.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: () => (text === '' ? undefined : JSON.parse(text)),
    };
  };
  const domain = seedTestDomain(harness, SPEC);
  const owner = `admin@${domain.spec.primaryDomain}`;
  const other = row<{ primary_email: string }>(
    domain.db
      .prepare('SELECT primary_email FROM users WHERE is_admin = 0 LIMIT 1')
      .get(),
  )!.primary_email;
  const token = grantToken(harness, domain, [DRIVE_SCOPE], owner);
  const otherToken = grantToken(harness, domain, [DRIVE_SCOPE], other);
  const drive = googleClient(harness, token, 'www.googleapis.com', '/drive/v3');
  const theirDrive = googleClient(
    harness,
    otherToken,
    'www.googleapis.com',
    '/drive/v3',
  );
  return {
    harness,
    domain,
    owner,
    other,
    token,
    otherToken,
    drive,
    theirDrive,
    call,
    root: `/domains/${domain.customerId}/drive`,
  };
}

test('a seeded file belongs to one subject until a control route grants it', async (t) => {
  const { call, root, drive, theirDrive, owner, other } = await setup(t);
  const seeded = await call('POST', `${root}/files`, {
    name: 'Devices.csv',
    content: 'id,name\n1,Ana\n',
  });
  assert.equal(seeded.status, 201);
  const file = seeded.json();
  assert.match(file.id, /^[A-Za-z0-9_-]{44}$/);
  assert.equal(file.owner, owner);
  assert.equal(file.mimeType, CSV_MIME);
  assert.deepEqual(file.granted, []);
  assert.equal(typeof file.createdTime, 'number');

  assert.deepEqual(
    (await drive('GET', '/files'))
      .json()
      .files.map((entry: { name: string }) => entry.name),
    ['Devices.csv'],
  );
  assert.equal((await theirDrive('GET', `/files/${file.id}`)).status, 404);
  assert.deepEqual((await theirDrive('GET', '/files')).json().files, []);

  const granted = await call('POST', `${root}/files/${file.id}/grant`, {
    subject: other,
  });
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.json(), { fileId: file.id, subjects: [other] });
  assert.equal((await theirDrive('GET', `/files/${file.id}`)).status, 200);
  assert.equal((await theirDrive('GET', '/files')).json().files.length, 1);
  assert.equal((await drive('GET', `/files/${file.id}`)).json().shared, true);
});

test('a seeded spreadsheet carries tabs, and an edit and a tab add reach the Sheets API', async (t) => {
  const { call, root, harness, domain, token } = await setup(t);
  const seeded = await call('POST', `${root}/files`, {
    id: 'edit-template',
    name: 'Edit template',
    tabs: [
      {
        title: 'Devices',
        rows: [
          ['id', 'name'],
          ['1', 'Ana'],
        ],
        frozenRowCount: 1,
      },
    ],
  });
  assert.equal(seeded.status, 201);
  const file = seeded.json();
  assert.equal(file.mimeType, SHEET_MIME);
  assert.deepEqual(
    file.tabs.map(
      (tab: { sheetId: number; title: string; frozenRowCount: number }) => [
        tab.sheetId,
        tab.title,
        tab.frozenRowCount,
      ],
    ),
    [[0, 'Devices', 1]],
  );
  const stored = harness.mock.drive.file(domain.customerId, file.id)!;
  assert.deepEqual(stored.spreadsheet!.tabs[0].rows, [
    ['id', 'name'],
    ['1', 'Ana'],
  ]);

  const sheets = googleClient(harness, token, 'sheets.googleapis.com');
  const read = await sheets(
    'GET',
    `/v4/spreadsheets/${file.id}/values/Devices!A1:B2`,
  );
  assert.deepEqual(read.json().values, [
    ['id', 'name'],
    ['1', 'Ana'],
  ]);

  const edited = await call('PUT', `${root}/files/${file.id}`, {
    name: 'Edited template',
    tabs: [
      {
        title: 'Devices',
        rows: [
          ['id', 'name'],
          ['1', 'Ana'],
          ['2', 'Ben'],
        ],
      },
    ],
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json().name, 'Edited template');
  assert.deepEqual(
    (
      await sheets('GET', `/v4/spreadsheets/${file.id}/values/Devices!A1:B3`)
    ).json().values,
    [
      ['id', 'name'],
      ['1', 'Ana'],
      ['2', 'Ben'],
    ],
  );

  const tab = await call('POST', `${root}/files/${file.id}/tabs`, {
    title: 'Second',
    rows: [['a']],
  });
  assert.equal(tab.status, 201);
  assert.deepEqual(
    [tab.json().sheetId, tab.json().index, tab.json().title],
    [1, 1, 'Second'],
  );
  const listed = await sheets('GET', `/v4/spreadsheets/${file.id}`);
  assert.deepEqual(
    listed
      .json()
      .sheets.map(
        (sheet: { properties: { title: string } }) => sheet.properties.title,
      ),
    ['Devices', 'Second'],
  );
  assert.equal((await call('DELETE', `${root}/files/${file.id}`)).status, 204);
  assert.equal(
    (await sheets('GET', `/v4/spreadsheets/${file.id}`)).status,
    404,
  );
  assert.equal((await call('DELETE', `${root}/files/${file.id}`)).status, 404);
});

test('the control routes refuse a body that they cannot read', async (t) => {
  const { call, root, other } = await setup(t);
  assert.equal(
    (
      await call('POST', `${root}/files`, {
        id: 'file-1',
        name: 'Devices.csv',
        content: 'a\n',
      })
    ).status,
    201,
  );
  const cases: [string, string, unknown][] = [
    ['POST', '/files', {}],
    ['POST', '/files', { name: '' }],
    ['POST', '/files', { name: 'x', owner: 'nobody@example.test' }],
    ['POST', '/files', { name: 'x', id: 'bad id' }],
    ['POST', '/files', { name: 'x', content: 'a', tabs: [{ title: 't' }] }],
    [
      'POST',
      '/files',
      { name: 'x', tabs: [{ title: 't' }], mimeType: CSV_MIME },
    ],
    ['POST', '/files', { name: 'x', tabs: [] }],
    ['POST', '/files', { name: 'x', tabs: [{ title: 't', rows: 'x' }] }],
    ['POST', '/files', { name: 'x', tabs: [{ title: 't', rows: [[1]] }] }],
    ['POST', '/files', { name: 'x', tabs: [{ title: 't', rowCount: 0 }] }],
    ['POST', '/files', { name: 'x', content: 4 }],
    ['POST', '/files', { name: 'x', mimeType: 4 }],
    ['PUT', '/files/file-1', { name: '' }],
    ['PUT', '/files/file-1', { tabs: [{ sheetId: 0, rows: [['a']] }] }],
    ['PUT', '/files/file-1', { tabs: 'x' }],
    ['PUT', '/files/file-1', { tabs: [4] }],
    ['POST', '/files/file-1/tabs', { title: 'x' }],
    ['POST', '/refusals', { subject: other, error: 'nope' }],
    [
      'POST',
      '/refusals',
      { subject: 'nobody@example.test', error: 'invalid_grant' },
    ],
  ];
  for (const [method, path, body] of cases) {
    const response = await call(method, `${root}${path}`, body);
    assert.equal(
      response.status,
      400,
      `${method} ${path} ${JSON.stringify(body)}`,
    );
  }
});

test('a control route answers 404 for a path or a file that does not exist', async (t) => {
  const { call, root, other } = await setup(t);
  const cases: [string, string, unknown][] = [
    ['GET', '/files', undefined],
    ['GET', '/refusals', undefined],
    ['GET', '/unknown', undefined],
    ['PUT', '/files/missing', { name: 'x' }],
    ['POST', '/files/missing/tabs', { title: 'x' }],
    ['POST', '/files/missing/grant', { subject: other }],
    ['DELETE', '/files/missing', undefined],
  ];
  for (const [method, path, body] of cases) {
    const response = await call(method, `${root}${path}`, body);
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  const created = await call('POST', `${root}/files`, {
    name: 'T',
    tabs: [{ title: 'Devices' }],
  });
  const id = created.json().id;
  assert.equal(
    (await call('POST', `${root}/files/${id}/tabs`, { title: 'Devices' }))
      .status,
    409,
  );
  assert.equal(
    (await call('POST', `${root}/files/${id}/tabs`, {})).status,
    400,
  );
  assert.equal(
    (await call('POST', `${root}/files/${id}/tabs`, { title: 'Second' }))
      .status,
    201,
  );
});

test('a refusal makes the Drive token exchange of one subject fail', async (t) => {
  const { harness, domain, other, call, root } = await setup(t);
  const account = issueServiceAccount(harness.mock.registry, domain.customerId);
  harness.mock.registry.setGrant(domain.customerId, account.client_id, [
    DRIVE_SCOPE,
  ]);
  const exchange = (sub: string, scope = DRIVE_SCOPE) =>
    harness.request({
      host: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenRequestBody(signAssertion(account, { scope, sub })),
    });
  assert.equal((await exchange(other)).status, 200);

  assert.equal(
    (
      await call('POST', `${root}/refusals`, {
        subject: other,
        error: 'invalid_grant',
      })
    ).status,
    201,
  );
  const refused = await exchange(other);
  assert.equal(refused.status, 400);
  assert.equal(refused.json().error, 'invalid_grant');
  assert.equal(refused.json().error_description, 'Invalid email or User ID');
  assert.equal(
    (await exchange(`admin@${domain.spec.primaryDomain}`)).status,
    200,
  );

  assert.equal(
    (
      await call('POST', `${root}/refusals`, {
        subject: other,
        error: 'unauthorized_client',
      })
    ).status,
    201,
  );
  const unauthorized = await exchange(other);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.json().error, 'unauthorized_client');

  assert.equal((await call('DELETE', `${root}/refusals`)).status, 204);
  assert.equal((await exchange(other)).status, 200);
  assert.equal(
    harness.mock.registry.driveRefusal(domain.customerId, other),
    undefined,
  );
});

test('an edit replaces the media text, and the media read answers the new bytes', async (t) => {
  const { call, root, drive } = await setup(t);
  const seeded = await call('POST', `${root}/files`, {
    id: 'editable-csv',
    name: 'Devices.csv',
    content: 'id,name\n1,Ana\n',
  });
  assert.equal(seeded.status, 201);
  assert.equal(
    (await drive('GET', '/files/editable-csv', { query: { alt: 'media' } }))
      .text,
    'id,name\n1,Ana\n',
  );
  const edited = await call('PUT', `${root}/files/editable-csv`, {
    content: 'id,name\n1,Ana\n2,Ben\n',
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json().name, 'Devices.csv');
  const media = await drive('GET', '/files/editable-csv', {
    query: { alt: 'media' },
  });
  assert.equal(media.text, 'id,name\n1,Ana\n2,Ben\n');
  assert.equal(
    media.headers['content-length'],
    String(Buffer.byteLength('id,name\n1,Ana\n2,Ben\n')),
  );
  assert.equal(
    (await drive('GET', '/files/editable-csv')).json().size,
    String(Buffer.byteLength('id,name\n1,Ana\n2,Ben\n')),
  );
});

test('a domain reset and a domain delete discard the files and the refusals', async (t) => {
  const { harness, domain, call, root, drive, owner } = await setup(t);
  await call('POST', `${root}/files`, {
    id: 'keep-or-drop',
    name: 'a.csv',
    content: 'a',
  });
  await call('POST', `${root}/refusals`, {
    subject: owner,
    error: 'invalid_grant',
  });
  assert.equal((await drive('GET', '/files/keep-or-drop')).status, 200);
  assert.equal(
    harness.mock.registry.driveRefusal(domain.customerId, owner),
    'invalid_grant',
  );
  assert.equal(
    (await call('POST', `/domains/${domain.customerId}/reset`)).status,
    200,
  );
  assert.equal((await drive('GET', '/files/keep-or-drop')).status, 404);
  assert.equal(
    harness.mock.registry.driveRefusal(domain.customerId, owner),
    undefined,
  );
  await call('POST', `${root}/files`, {
    id: 'second',
    name: 'b.csv',
    content: 'b',
  });
  assert.equal(
    (await call('DELETE', `/domains/${domain.customerId}`)).status,
    204,
  );
  assert.deepEqual(harness.mock.drive.visible(domain.customerId, 'anyone'), []);
});
