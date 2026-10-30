import assert from 'node:assert/strict';
import test from 'node:test';
import { WRITE_SCOPES } from '../auth/scopes.ts';
import { row } from '../store/sqlite.ts';
import {
  googleClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { CSV_MIME, SHEET_MIME } from './store.ts';

const SPEC = {
  tier: 'small',
  seed: 'drive',
  counts: { schools: 1, students: 20, staff: 3, devices: 5 },
};
const CONTENT = 'id,name,serial\n1,Ana,PF1\n2,Ben,PF2\n';

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const owner = `admin@${domain.spec.primaryDomain}`;
  const other = row<{ primary_email: string }>(
    domain.db
      .prepare('SELECT primary_email FROM users WHERE is_admin = 0 LIMIT 1')
      .get(),
  )!.primary_email;
  const token = grantToken(harness, domain, WRITE_SCOPES.drive, owner);
  const otherToken = grantToken(harness, domain, WRITE_SCOPES.drive, other);
  const call = googleClient(harness, token, 'www.googleapis.com', '/drive/v3');
  const file = harness.mock.drive.create(domain.customerId, {
    name: 'Devices.csv',
    mimeType: CSV_MIME,
    owner,
    content: CONTENT,
  });
  return { harness, domain, owner, other, token, otherToken, call, file };
}

test('files.list returns the files of the token subject alone', async (t) => {
  const { harness, domain, owner, other, call, otherToken } = await setup(t);
  harness.mock.drive.create(domain.customerId, {
    name: 'Other.csv',
    mimeType: CSV_MIME,
    owner: other,
    content: 'a\n',
  });
  const listed = await call('GET', '/files');
  assert.equal(listed.status, 200);
  const body = listed.json();
  assert.equal(body.kind, 'drive#fileList');
  assert.equal(body.incompleteSearch, false);
  assert.equal(body.files.length, 1);
  const [file] = body.files;
  assert.equal(file.kind, 'drive#file');
  assert.equal(file.name, 'Devices.csv');
  assert.equal(file.mimeType, CSV_MIME);
  assert.equal(file.ownedByMe, true);
  assert.equal(file.shared, false);
  assert.equal(file.trashed, false);
  assert.equal(file.size, String(Buffer.byteLength(CONTENT)));
  assert.match(file.id, /^[A-Za-z0-9_-]{44}$/);
  assert.match(file.createdTime, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Date.parse(file.modifiedTime) >= Date.parse(file.createdTime));

  const theirs = googleClient(
    harness,
    otherToken,
    'www.googleapis.com',
    '/drive/v3',
  )('GET', '/files');
  assert.deepEqual(
    (await theirs).json().files.map((entry: { name: string }) => entry.name),
    ['Other.csv'],
  );
  assert.equal(owner, 'admin@' + domain.spec.primaryDomain);
});

test('files.list pages, clamps the page size, and applies fields', async (t) => {
  const { harness, domain, owner, call } = await setup(t);
  for (const name of ['b.csv', 'c.csv'])
    harness.mock.drive.create(domain.customerId, {
      name,
      mimeType: CSV_MIME,
      owner,
      content: 'a\n',
    });
  const first = await call('GET', '/files', { query: { pageSize: 2 } });
  assert.equal(first.json().files.length, 2);
  assert.equal(typeof first.json().nextPageToken, 'string');
  const second = await call('GET', '/files', {
    query: { pageSize: 2, pageToken: first.json().nextPageToken },
  });
  assert.equal(second.json().files.length, 1);
  assert.equal(second.json().nextPageToken, undefined);
  const clamped = await call('GET', '/files', { query: { pageSize: 5_000 } });
  assert.equal(clamped.json().files.length, 3);
  const trimmed = await call('GET', '/files', {
    query: { fields: 'files(id,name)', prettyPrint: false },
  });
  assert.deepEqual(Object.keys(trimmed.json()), ['files']);
  assert.deepEqual(Object.keys(trimmed.json().files[0]), ['id', 'name']);
  const beyond = await call('GET', '/files', {
    query: { pageSize: 2, pageToken: Buffer.from('9').toString('base64url') },
  });
  assert.deepEqual(beyond.json().files, []);
});

test('files.list refuses a bad page size and a bad page token', async (t) => {
  const { call } = await setup(t);
  for (const query of [
    { pageSize: '0' },
    { pageSize: 'x' },
    { pageToken: 'zzz' },
    { pageToken: '-1' },
  ]) {
    const response = await call('GET', '/files', { query });
    assert.equal(response.status, 400, JSON.stringify(query));
    assert.equal(response.json().error.errors[0].reason, 'invalidParameter');
  }
});

test('files.get returns the metadata of one file, and 404 for a stranger', async (t) => {
  const { harness, file, call, otherToken } = await setup(t);
  const found = await call('GET', `/files/${file.id}`);
  assert.equal(found.status, 200);
  assert.equal(found.json().id, file.id);
  assert.equal(found.json().name, 'Devices.csv');
  assert.equal(found.json().size, String(Buffer.byteLength(CONTENT)));

  const stranger = await googleClient(
    harness,
    otherToken,
    'www.googleapis.com',
    '/drive/v3',
  )('GET', `/files/${file.id}`);
  assert.equal(stranger.status, 404);
  assert.equal(stranger.json().error.errors[0].reason, 'notFound');
  assert.equal(stranger.json().error.message, `File not found: ${file.id}.`);

  const missing = await call('GET', '/files/nope');
  assert.equal(missing.status, 404);
});

test('the media read returns the bytes, and a Range slices them', async (t) => {
  const { file, call } = await setup(t);
  const whole = await call('GET', `/files/${file.id}`, {
    query: { alt: 'media' },
  });
  assert.equal(whole.status, 200);
  assert.equal(whole.text, CONTENT);
  assert.equal(whole.headers['content-type'], CSV_MIME);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(
    whole.headers['content-length'],
    String(Buffer.byteLength(CONTENT)),
  );

  const first = await call('GET', `/files/${file.id}`, {
    query: { alt: 'media' },
    headers: { range: 'bytes=0-9' },
  });
  assert.equal(first.status, 206);
  assert.equal(first.text, CONTENT.slice(0, 10));
  assert.equal(
    first.headers['content-range'],
    `bytes 0-9/${Buffer.byteLength(CONTENT)}`,
  );

  const tail = await call('GET', `/files/${file.id}`, {
    query: { alt: 'media' },
    headers: { range: 'bytes=-3' },
  });
  assert.equal(tail.status, 206);
  assert.equal(tail.text, CONTENT.slice(-3));

  const open = await call('GET', `/files/${file.id}`, {
    query: { alt: 'media' },
    headers: { range: 'bytes=5-' },
  });
  assert.equal(open.status, 206);
  assert.equal(open.text, CONTENT.slice(5));

  for (const range of ['bytes=9999-', 'bytes=9-2', 'bytes=-0']) {
    const unsatisfied = await call('GET', `/files/${file.id}`, {
      query: { alt: 'media' },
      headers: { range },
    });
    assert.equal(unsatisfied.status, 416, range);
    assert.equal(
      unsatisfied.headers['content-range'],
      `bytes */${Buffer.byteLength(CONTENT)}`,
    );
  }

  for (const range of ['pages=0-1', 'bytes=', 'bytes=0-1,4-5']) {
    const ignored = await call('GET', `/files/${file.id}`, {
      query: { alt: 'media' },
      headers: { range },
    });
    assert.equal(ignored.status, 200, range);
    assert.equal(ignored.text, CONTENT);
  }
});

test('the media read of a Google Sheet answers 403, and a stranger gets 404', async (t) => {
  const { harness, domain, owner, file, call } = await setup(t);
  const sheet = harness.mock.drive.create(domain.customerId, {
    name: 'Edit template',
    mimeType: SHEET_MIME,
    owner,
    tabs: [{ title: 'Devices', rows: [['id']] }],
  });
  const refused = await call('GET', `/files/${sheet.id}`, {
    query: { alt: 'media' },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json().error.errors[0].reason, 'fileNotDownloadable');

  const stranger = await call('GET', `/files/${sheet.id}`);
  assert.equal(stranger.status, 200);
  assert.equal(stranger.json().mimeType, SHEET_MIME);
  assert.equal(stranger.json().size, undefined);
  assert.equal(stranger.json().id, sheet.id);
  assert.notEqual(file.id, sheet.id);
});

test('the media read of another subject answers 404', async (t) => {
  const { harness, file, otherToken } = await setup(t);
  const response = await googleClient(
    harness,
    otherToken,
    'www.googleapis.com',
    '/drive/v3',
  )('GET', `/files/${file.id}`, { query: { alt: 'media' } });
  assert.equal(response.status, 404);
});

test('Drive routes need a token with the file scope', async (t) => {
  const { harness, domain, file } = await setup(t);
  const none = await harness.request({
    host: 'www.googleapis.com',
    path: `/drive/v3/files/${file.id}`,
  });
  assert.equal(none.status, 401);
  const readOnly = grantToken(harness, domain, [
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
  ]);
  const refused = await harness.request({
    host: 'www.googleapis.com',
    path: '/drive/v3/files',
    token: readOnly,
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json().error.status, 'PERMISSION_DENIED');
  assert.equal(
    refused.json().error.details[0].metadata.service,
    'drive.googleapis.com',
  );
});
