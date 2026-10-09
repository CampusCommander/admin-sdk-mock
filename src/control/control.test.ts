import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { SCOPES } from '../auth/scopes.ts';
import { startHarness } from '../testing/harness.ts';
import { signAssertion, tokenRequestBody } from '../testing/jwt.ts';
import { createControlHandler } from './control.ts';

const SPEC = {
  tier: 'small',
  seed: 'control',
  counts: { schools: 2, students: 60, staff: 10, devices: 80 },
};

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
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: () => JSON.parse(text) };
  };
  const port = (server.address() as AddressInfo).port;
  /** A raw request, so a test can set the Host and Content-Type headers. */
  const raw = (
    method: string,
    path: string,
    headers: http.OutgoingHttpHeaders,
    body?: string,
  ) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, method, path, headers },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, text }),
          );
        },
      );
      request.on('error', reject);
      request.end(body);
    });
  return { harness, call, raw };
}

test('the control API creates a domain that serves real token exchanges', async (t) => {
  const { harness, call } = await setup(t);
  const created = await call('POST', '/domains', SPEC);
  assert.equal(created.status, 201);
  const { customerId, adminEmail, counts } = created.json();
  assert.equal(counts.devices, 80);
  assert.equal((await call('POST', '/domains', SPEC)).status, 409);
  assert.equal(
    (await call('POST', '/domains', { tier: 'huge', seed: 'x' })).status,
    400,
  );
  assert.equal((await call('POST', '/domains', '{not json')).status, 400);
  assert.equal((await call('GET', '/domains')).json().length, 1);
  assert.equal(
    (await call('GET', `/domains/${customerId}`)).json().customerId,
    customerId,
  );

  const account = (
    await call('POST', `/domains/${customerId}/service-accounts`, {})
  ).json();
  assert.equal(account.type, 'service_account');
  const scope = SCOPES.orgunit[1];
  assert.equal(
    (
      await call(
        'PUT',
        `/domains/${customerId}/delegation/${account.client_id}`,
        { scopes: [scope] },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        'PUT',
        `/domains/${customerId}/delegation/${account.client_id}`,
        { scopes: ['bad'] },
      )
    ).status,
    400,
  );
  const token = await harness.request({
    host: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    body: tokenRequestBody(signAssertion(account, { scope, sub: adminEmail })),
  });
  assert.equal(token.status, 200);
  const orgunits = await harness.request({
    host: 'admin.googleapis.com',
    path: '/admin/directory/v1/customer/my_customer/orgunits',
    token: token.json().access_token,
  });
  assert.equal(orgunits.status, 200);
  const quota = (await call('GET', `/domains/${customerId}/quota`)).json();
  assert.equal(quota.buckets[0].snapshot.count, 1);
});

test('settings, faults, clock, CA, reset, and delete work through the control API', async (t) => {
  const { harness, call } = await setup(t);
  const { customerId } = (await call('POST', '/domains', SPEC)).json();
  assert.equal(
    (
      await call('PUT', `/domains/${customerId}/settings`, {
        quota: { perMinute: 7 },
      })
    ).json().quota.perMinute,
    7,
  );
  assert.equal(
    (
      await call('PUT', `/domains/${customerId}/settings`, {
        quota: { perMinute: -1 },
      })
    ).status,
    400,
  );
  const fault = await call('POST', `/domains/${customerId}/faults`, {
    kind: 'reset',
    count: 1,
  });
  assert.equal(fault.status, 201);
  assert.equal(
    (await call('GET', `/domains/${customerId}/faults`)).json().length,
    1,
  );
  assert.equal(
    (await call('POST', `/domains/${customerId}/faults`, { kind: 'meteor' }))
      .status,
    400,
  );
  assert.equal(
    (await call('DELETE', `/domains/${customerId}/faults`)).status,
    204,
  );
  const clock = await call('PUT', '/clock', { scale: 60, delays: false });
  assert.deepEqual(clock.json(), { scale: 60, delays: false });
  assert.equal(harness.mock.timing.scale, 60);
  assert.equal((await call('PUT', '/clock', { scale: 0 })).status, 400);
  assert.match((await call('GET', '/ca.pem')).text, /BEGIN CERTIFICATE/);
  assert.equal(
    (await call('POST', `/domains/${customerId}/reset`)).status,
    200,
  );
  assert.equal((await call('DELETE', `/domains/${customerId}`)).status, 204);
  assert.equal((await call('GET', `/domains/${customerId}`)).status, 404);
  assert.equal((await call('GET', '/nothing')).status, 404);
  assert.deepEqual((await call('GET', '/health')).json(), {
    status: 'ok',
    domains: 0,
  });
});

test('a malformed percent-escape in the path answers 400', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('GET', '/domains/%zz')).status, 400);
  assert.equal((await call('GET', '/domains/%E0%A4%A')).status, 400);
});

test('a body that is not a JSON object answers 400 on every body route', async (t) => {
  const { call } = await setup(t);
  const { customerId } = (await call('POST', '/domains', SPEC)).json();
  const routes: [string, string][] = [
    ['PUT', '/clock'],
    ['POST', `/domains/${customerId}/service-accounts`],
    ['PUT', `/domains/${customerId}/settings`],
    ['POST', `/domains/${customerId}/faults`],
    ['PUT', `/domains/${customerId}/delegation/1`],
    ['POST', '/domains'],
  ];
  for (const [method, path] of routes)
    for (const body of ['null', '[]', '"text"', '7']) {
      const response = await call(method, path, body);
      assert.equal(response.status, 400, `${method} ${path} ${body}`);
    }
});

test('PUT /clock validates scale and delays before it changes anything', async (t) => {
  const { harness, call } = await setup(t);
  const before = { ...harness.mock.timing };
  const response = await call('PUT', '/clock', { scale: 30, delays: 'off' });
  assert.equal(response.status, 400);
  assert.deepEqual({ ...harness.mock.timing }, before);
});

test('GET /domains lists each domain with its counts', async (t) => {
  const { call } = await setup(t);
  const { customerId } = (await call('POST', '/domains', SPEC)).json();
  const [listed] = (await call('GET', '/domains')).json();
  assert.equal(listed.customerId, customerId);
  assert.equal(listed.counts.devices, 80);
  assert.ok(listed.counts.orgUnits > 0);
  assert.ok(listed.counts.users > 0);
});

test('bodies need application/json and the Host must be local', async (t) => {
  const { raw } = await setup(t);
  const body = JSON.stringify(SPEC);
  const json = { 'content-type': 'application/json' };
  assert.equal(
    (await raw('POST', '/domains', { 'content-type': 'text/plain' }, body))
      .status,
    415,
  );
  assert.equal((await raw('POST', '/domains', {}, body)).status, 415);
  assert.equal(
    (
      await raw(
        'POST',
        '/domains',
        { 'content-type': 'application/json; charset=utf-8' },
        body,
      )
    ).status,
    201,
  );
  for (const host of [
    'evil.example',
    'evil.example:8080',
    '127.0.0.1.evil.example',
  ])
    assert.equal(
      (await raw('POST', '/domains', { ...json, host }, body)).status,
      403,
      host,
    );
  assert.equal(
    (await raw('GET', '/health', { host: 'evil.test' })).status,
    403,
  );
  for (const host of [
    'localhost',
    'localhost:8080',
    '127.0.0.1:18080',
    '[::1]:8080',
    'admin-sdk-mock:8080',
  ])
    assert.equal((await raw('GET', '/health', { host })).status, 200, host);
});
