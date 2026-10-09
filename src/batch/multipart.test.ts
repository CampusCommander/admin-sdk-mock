import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BatchFormatError,
  buildBatchResponse,
  parseBatchRequest,
} from './multipart.ts';

/** The exact body that Campus Commander's buildMultipartBody produces. */
const CAMPUS_COMMANDER = [
  '--batch_x',
  'Content-Type: application/http',
  'Content-ID: <cc-1>',
  '',
  'GET /admin/directory/v1/customer/C0123456/devices/chromeos/d1?fields=deviceId',
  '',
  '--batch_x',
  'Content-Type: application/http',
  'Content-ID: <cc-2>',
  '',
  'POST /admin/directory/v1/users',
  'Content-Type: application/json; charset=UTF-8',
  '',
  '{"a":1}',
  '--batch_x--',
  '',
].join('\r\n');

test('the Campus Commander format parses into parts', () => {
  const parts = parseBatchRequest(
    'multipart/mixed; boundary=batch_x',
    CAMPUS_COMMANDER,
  );
  assert.equal(parts.length, 2);
  assert.deepEqual(
    { ...parts[0], query: parts[0].query.toString() },
    {
      contentId: 'cc-1',
      method: 'GET',
      host: 'admin.googleapis.com',
      path: '/admin/directory/v1/customer/C0123456/devices/chromeos/d1',
      query: 'fields=deviceId',
      headers: {},
      body: '',
    },
  );
  assert.equal(parts[1].method, 'POST');
  assert.equal(parts[1].body, '{"a":1}');
  assert.equal(
    parts[1].headers['content-type'],
    'application/json; charset=UTF-8',
  );
});

test('LF line endings, absolute URLs, HTTP versions, and quoted boundaries parse', () => {
  const body = [
    '--b',
    'Content-Type: application/http',
    'Content-ID: <one>',
    '',
    'GET https://www.googleapis.com/admin/directory/v1/users/u1 HTTP/1.1',
    'Authorization: Bearer part-token',
    '',
    '',
    '--b--',
  ].join('\n');
  const [part] = parseBatchRequest('multipart/mixed; boundary="b"', body);
  assert.equal(part.contentId, 'one');
  assert.equal(part.host, 'www.googleapis.com');
  assert.equal(part.path, '/admin/directory/v1/users/u1');
  assert.equal(part.headers.authorization, 'Bearer part-token');
});

test('a missing boundary or a bad request line fails', () => {
  assert.throws(
    () => parseBatchRequest('application/json', ''),
    BatchFormatError,
  );
  assert.throws(
    () =>
      parseBatchRequest(
        'multipart/mixed; boundary=b',
        '--b\r\nContent-Type: application/http\r\n\r\nnonsense\r\n--b--',
      ),
    BatchFormatError,
  );
});

test('a response echoes each Content-ID with the response- prefix', () => {
  const text = buildBatchResponse(
    [
      {
        contentId: 'cc-1',
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: '{"ok":true}',
      },
      {
        contentId: null,
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: '{}',
      },
    ],
    'resp',
  );
  assert.match(
    text,
    /^--resp\r\nContent-Type: application\/http\r\nContent-ID: <response-cc-1>\r\n\r\nHTTP\/1\.1 200 OK\r\n/,
  );
  assert.match(text, /HTTP\/1\.1 404 Not Found/);
  assert.ok(text.endsWith('--resp--\r\n'));
});
