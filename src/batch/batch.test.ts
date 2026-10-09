import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES } from '../auth/scopes.ts';
import { rows } from '../store/sqlite.ts';
import {
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

interface Part {
  contentId: string | undefined;
  status: number;
  body: string;
}

function parseResponse(contentType: string, text: string): Part[] {
  const boundary = /boundary=([^;\s]+)/.exec(contentType)![1];
  return text
    .split(`--${boundary}`)
    .slice(1)
    .filter((section) => !section.startsWith('--'))
    .map((section) => {
      const body = section.replace(/^\r\n/, '');
      const outerEnd = body.indexOf('\r\n\r\n');
      const outer = body.slice(0, outerEnd);
      const rest = body.slice(outerEnd + 4);
      const innerEnd = rest.indexOf('\r\n\r\n');
      return {
        contentId: /Content-ID: <([^>]+)>/.exec(outer)?.[1],
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(rest)![1]),
        body: rest.slice(innerEnd + 4).replace(/\r\n$/, ''),
      };
    });
}

function body(parts: { id: string; line: string; auth?: string }[]): string {
  return (
    parts
      .map(({ id, line, auth }) =>
        [
          '--b',
          'Content-Type: application/http',
          `Content-ID: <${id}>`,
          '',
          line,
          ...(auth ? [`Authorization: Bearer ${auth}`] : []),
          '',
          '',
        ].join('\r\n'),
      )
      .join('') + '--b--\r\n'
  );
}

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, READ_SCOPES);
  const ids = rows<{ device_id: string }>(
    domain.db.prepare('SELECT device_id FROM devices LIMIT 2').all(),
  ).map((r) => r.device_id);
  const send = (
    text: string,
    options: {
      host?: string;
      path?: string;
      bearer?: string;
      contentType?: string;
    } = {},
  ) =>
    harness.request({
      host: options.host ?? 'www.googleapis.com',
      path: options.path ?? '/batch/admin/directory_v1',
      method: 'POST',
      token: options.bearer,
      headers: {
        'content-type': options.contentType ?? 'multipart/mixed; boundary=b',
      },
      body: text,
    });
  return { harness, domain, token, ids, send };
}

test('a batch answers each part with its own status and echoed Content-ID', async (t) => {
  const { token, ids, send, domain } = await setup(t);
  const devices = `/admin/directory/v1/customer/${domain.customerId}/devices/chromeos`;
  const response = await send(
    body([
      { id: 'cc-1', line: `GET ${devices}/${ids[0]}` },
      { id: 'cc-2', line: `GET ${devices}/${ids[1]}?fields=deviceId` },
      { id: 'cc-3', line: `GET ${devices}/missing` },
    ]),
    { bearer: token },
  );
  assert.equal(response.status, 200);
  const parts = parseResponse(
    String(response.headers['content-type']),
    response.text,
  );
  assert.deepEqual(
    parts.map((part) => [part.contentId, part.status]),
    [
      ['response-cc-1', 200],
      ['response-cc-2', 200],
      ['response-cc-3', 404],
    ],
  );
  assert.equal(JSON.parse(parts[0].body).deviceId, ids[0]);
  assert.deepEqual(Object.keys(JSON.parse(parts[1].body)), ['deviceId']);
});

test('a part uses its own token before the outer token', async (t) => {
  const { token, send } = await setup(t);
  const response = await send(
    body([
      {
        id: 'a',
        line: 'GET /admin/directory/v1/customer/my_customer/orgunits',
      },
      {
        id: 'b',
        line: 'GET /admin/directory/v1/customer/my_customer/orgunits',
        auth: token,
      },
    ]),
  );
  const parts = parseResponse(
    String(response.headers['content-type']),
    response.text,
  );
  assert.deepEqual(
    parts.map((part) => part.status),
    [401, 200],
  );
});

test('the admin host and the short batch path also work', async (t) => {
  const { token, send } = await setup(t);
  const response = await send(
    body([
      {
        id: 'x',
        line: 'GET /admin/directory/v1/customer/my_customer/orgunits',
      },
    ]),
    {
      host: 'admin.googleapis.com',
      path: '/batch',
      bearer: token,
    },
  );
  assert.equal(
    parseResponse(String(response.headers['content-type']), response.text)[0]
      .status,
    200,
  );
});

test('oversized and malformed batches fail with 400', async (t) => {
  const { token, send } = await setup(t);
  const many = body(
    Array.from({ length: 1001 }, (_, i) => ({
      id: `p${i}`,
      line: 'GET /admin/directory/v1/customer/my_customer/orgunits',
    })),
  );
  assert.equal((await send(many, { bearer: token })).status, 400);
  assert.equal(
    (await send('{}', { bearer: token, contentType: 'application/json' }))
      .status,
    400,
  );
});
