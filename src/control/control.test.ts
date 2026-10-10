import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { READ_WRITE_SCOPES, SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { saveBeforeImage } from '../store/lag.ts';
import { row } from '../store/sqlite.ts';
import { addTestGroup, addTestMember } from '../testing/groups.ts';
import {
  directoryClient,
  grantToken,
  startHarness,
} from '../testing/harness.ts';
import { signAssertion, tokenRequestBody } from '../testing/jwt.ts';
import { createControlHandler } from './control.ts';

const SPEC = {
  tier: 'small',
  seed: 'control',
  counts: { schools: 2, students: 60, staff: 10, devices: 80 },
};

async function setup(
  t: import('node:test').TestContext,
  options: Parameters<typeof startHarness>[0] = {},
  control: Parameters<typeof createControlHandler>[1] = {},
) {
  const harness = await startHarness(options);
  const server = http.createServer(createControlHandler(harness.mock, control));
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

test('index flush makes pending writes visible, and GET /domains counts them', async (t) => {
  const { harness, call } = await setup(t);
  const created = (await call('POST', '/domains', SPEC)).json();
  const domain = harness.mock.domains.get(created.customerId)!;
  const deviceId = (
    domain.db.prepare('SELECT device_id FROM devices LIMIT 1').get() as {
      device_id: string;
    }
  ).device_id;
  saveBeforeImage(
    domain.db,
    'devices',
    deviceId,
    harness.mock.clock.now(),
    300_000,
  );
  const pending = async () =>
    (await call('GET', '/domains'))
      .json()
      .find(
        (entry: { customerId: string }) =>
          entry.customerId === created.customerId,
      ).counts.pendingWrites;
  assert.equal(await pending(), 1);
  const flushed = await call(
    'POST',
    `/domains/${created.customerId}/index/flush`,
  );
  assert.equal(flushed.status, 200, flushed.text);
  assert.deepEqual(flushed.json(), { flushed: 1, delaysEnded: 0 });
  assert.equal(await pending(), 0);
  assert.equal(
    (await call('POST', '/domains/C0missing/index/flush')).status,
    404,
  );
});

test('a flush settles due commands so lists show their effects', async (t) => {
  const clock = fakeClock();
  const { harness, call } = await setup(t, {
    clock,
    timing: { scale: 1, delays: false },
  });
  const created = (await call('POST', '/domains', SPEC)).json();
  const domain = harness.mock.domains.get(created.customerId)!;
  const api: ReturnType<typeof directoryClient> = (method, path, options) =>
    directoryClient(harness, grantToken(harness, domain, READ_WRITE_SCOPES))(
      method,
      path,
      options,
    );
  const DEVICES = '/customer/my_customer/devices/chromeos';
  const device = domain.db
    .prepare(
      "SELECT device_id, serial_number FROM devices WHERE status = 'ACTIVE' AND last_sync >= ? ORDER BY ord LIMIT 1",
    )
    .get(clock.now() - 86_400_000) as {
    device_id: string;
    serial_number: string;
  };
  let succeeded = false;
  for (let attempt = 0; attempt < 10 && !succeeded; attempt++) {
    const issued = await api(
      'POST',
      `${DEVICES}/${device.device_id}:issueCommand`,
      {
        body: { commandType: 'REBOOT' },
      },
    );
    assert.equal(issued.status, 200, issued.text);
    await clock.advance(61_000);
    // No device read here, so the command stays unsettled until the flush.
    const flushed = await call(
      'POST',
      `/domains/${created.customerId}/index/flush`,
    );
    assert.equal(flushed.status, 200, flushed.text);
    // Read the list and the device before the command itself, so nothing else settles it.
    const listed = (
      await api('GET', DEVICES, {
        query: {
          query: `id:${device.serial_number}`,
          fields: 'chromeosdevices(deviceId,lastSync)',
        },
      })
    ).json().chromeosdevices[0].lastSync;
    const got = (await api('GET', `${DEVICES}/${device.device_id}`)).json();
    assert.equal(listed, got.lastSync);
    const command = (
      await api(
        'GET',
        `${DEVICES}/${device.device_id}/commands/${issued.json().commandId}`,
      )
    ).json();
    succeeded = command.commandResult.result === 'SUCCESS';
    if (succeeded) assert.equal(listed, command.commandResult.executeTime);
  }
  assert.ok(succeeded);
});

test('a reset discards every write, before-image, command, and deleted user', async (t) => {
  const { harness, call } = await setup(t);
  const created = (await call('POST', '/domains', SPEC)).json();
  const domain = harness.mock.domains.get(created.customerId)!;
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const first = (sql: string) =>
    Object.values(domain.db.prepare(sql).get() as Record<string, string>)[0];
  const deviceId = first(
    "SELECT device_id FROM devices WHERE status = 'ACTIVE' ORDER BY ord LIMIT 1",
  );
  const userId = first(
    'SELECT id FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 1',
  );
  const devices = '/customer/my_customer/devices/chromeos';
  await api('PATCH', `${devices}/${deviceId}`, {
    body: { notes: 'Before reset' },
  });
  await api('POST', `${devices}/${deviceId}:issueCommand`, {
    body: { commandType: 'REBOOT' },
  });
  assert.equal((await api('DELETE', `/users/${userId}`)).status, 204);
  assert.equal(
    (await call('POST', `/domains/${created.customerId}/reset`)).status,
    200,
  );
  const fresh = harness.mock.domains.get(created.customerId)!;
  const count = (sql: string) =>
    Number(
      Object.values(fresh.db.prepare(sql).get() as Record<string, number>)[0],
    );
  assert.equal(count('SELECT count(*) FROM device_commands'), 0);
  assert.equal(count('SELECT count(*) FROM deleted_users'), 0);
  assert.equal(count('SELECT count(*) FROM devices_prior'), 0);
  assert.equal(count(`SELECT count(*) FROM users WHERE id = '${userId}'`), 1);
  assert.notEqual(
    Object.values(
      fresh.db
        .prepare(
          `SELECT COALESCE(notes, '') FROM devices WHERE device_id = '${deviceId}'`,
        )
        .get() as Record<string, string>,
    )[0],
    'Before reset',
  );
});

test('flush ends pending nesting and ready delays', async (t) => {
  const { harness, call } = await setup(t);
  const { customerId } = (await call('POST', '/domains', SPEC)).json();
  const domain = harness.mock.domains.get(customerId)!;
  const P = domain.spec.primaryDomain;
  const now = harness.mock.clock.now();
  const fresh = addTestGroup(domain.db, {
    email: `fresh@${P}`,
    createdAt: now,
  });
  const parent = addTestGroup(domain.db, { email: `parent@${P}` });
  addTestMember(domain.db, {
    groupId: parent.id,
    memberId: fresh.id,
    email: fresh.email,
    type: 'GROUP',
    addedAt: now,
  });
  const flushed = await call('POST', `/domains/${customerId}/index/flush`);
  assert.equal(flushed.status, 200);
  assert.equal(flushed.json().delaysEnded, 2);
  assert.equal(
    row<{ created_at: number }>(
      domain.db
        .prepare('SELECT created_at FROM groups WHERE id = ?')
        .get(fresh.id),
    )!.created_at,
    0,
  );
  assert.equal(
    row<{ added_at: number }>(
      domain.db
        .prepare(
          'SELECT added_at FROM group_members WHERE group_id = ? AND member_id = ?',
        )
        .get(parent.id, fresh.id),
    )!.added_at,
    0,
  );
  const again = await call('POST', `/domains/${customerId}/index/flush`);
  assert.equal(again.json().delaysEnded, 0);
});

test('domain counts include groups and memberships', async (t) => {
  const { harness, call } = await setup(t);
  const { customerId } = (await call('POST', '/domains', SPEC)).json();
  const domain = harness.mock.domains.get(customerId)!;
  const listed = (await call('GET', '/domains'))
    .json()
    .find((entry: { customerId: string }) => entry.customerId === customerId);
  const count = (table: string) =>
    Number(
      row<{ n: number }>(
        domain.db.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
      )!.n,
    );
  assert.equal(listed.counts.groups, count('groups'));
  assert.equal(listed.counts.memberships, count('group_members'));
  assert.ok(listed.counts.groups > 0);
});

test('a domain reset discards group writes', async (t) => {
  const { harness, call } = await setup(t);
  const { customerId } = (await call('POST', '/domains', SPEC)).json();
  const before = harness.mock.domains.get(customerId)!;
  const P = before.spec.primaryDomain;
  addTestGroup(before.db, { email: `written@${P}` });
  assert.equal(
    (await call('POST', `/domains/${customerId}/reset`)).status,
    200,
  );
  const after = harness.mock.domains.get(customerId)!;
  assert.equal(
    after.db
      .prepare('SELECT 1 FROM groups WHERE email = ?')
      .get(`written@${P}`),
    undefined,
  );
  assert.ok(
    Number(
      row<{ n: number }>(
        after.db.prepare('SELECT count(*) AS n FROM groups').get(),
      )!.n,
    ) > 0,
  );
});

test('GET /info answers the info provider, and 404 without one', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('GET', '/info')).status, 404);

  const info = {
    version: '1.0.0',
    ready: true,
    listeners: {
      google: { host: '127.0.0.1', port: 8443 },
      control: { host: '127.0.0.1', port: 8080 },
      proxy: null,
    },
    caFile: '/data/ca/ca.pem',
    caBundleFile: '/data/ca/ca-bundle.pem',
    dataDir: '/data',
    domains: [],
  };
  const provided = await setup(t, {}, { info: () => info });
  const response = await provided.call('GET', '/info');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), info);
  assert.equal(
    (await provided.raw('GET', '/info', { host: 'attacker.example' })).status,
    403,
  );
});

test('POST /domains/{id}/tokens stores a token for a domain user', async (t) => {
  const clock = fakeClock();
  const { harness, call } = await setup(t, { clock });
  const { customerId, adminEmail } = (
    await call('POST', '/domains', { tier: 'empty', seed: 'tokens' })
  ).json();
  const path = `/domains/${customerId}/tokens`;

  const issued = await call('POST', path, {});
  assert.equal(issued.status, 200);
  const body = issued.json();
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.expires_in, 3600);
  assert.equal(body.scope, READ_WRITE_SCOPES.join(' '));
  assert.deepEqual(harness.mock.registry.token(body.access_token), {
    token: body.access_token,
    clientId: '100000000000000000000',
    projectId: 'admin-sdk-mock-control',
    subject: adminEmail,
    customerId,
    scopes: READ_WRITE_SCOPES,
    expiresAt: clock.now() + 3_600_000,
  });
  const users = await directoryClient(harness, body.access_token)(
    'GET',
    '/users',
    { query: { customer: 'my_customer' } },
  );
  assert.equal(users.status, 200);

  const scope = SCOPES.orgunit[1];
  const narrow = (
    await call('POST', path, {
      subject: adminEmail,
      scopes: [scope],
      ttlSeconds: 60,
    })
  ).json();
  assert.equal(narrow.scope, scope);
  assert.equal(narrow.expires_in, 60);
  assert.equal(
    harness.mock.registry.token(narrow.access_token)?.expiresAt,
    clock.now() + 60_000,
  );

  for (const [input, error] of [
    [
      { subject: 'nobody@example.test' },
      'subject must name a user of the domain.',
    ],
    [{ subject: 42 }, 'subject must name a user of the domain.'],
    [{ scopes: 'everything' }, undefined],
    [{ scopes: [1] }, undefined],
    [{ ttlSeconds: 0 }, 'ttlSeconds must be a whole number from 1 to 3600.'],
    [{ ttlSeconds: 3601 }, 'ttlSeconds must be a whole number from 1 to 3600.'],
    [{ ttlSeconds: 2.5 }, 'ttlSeconds must be a whole number from 1 to 3600.'],
  ] as const) {
    const response = await call('POST', path, input);
    assert.equal(response.status, 400, JSON.stringify(input));
    if (error) assert.equal(response.json().error, error);
  }
  assert.equal(
    (await call('POST', '/domains/C0missing/tokens', {})).status,
    404,
  );
});

test('a minted token stores the primary email of its user, so demote-subject matches a token minted by ID', async (t) => {
  const { harness, call } = await setup(t);
  const { customerId, adminEmail } = (
    await call('POST', '/domains', { tier: 'empty', seed: 'subjects' })
  ).json();
  const db = harness.mock.domains.get(customerId)!.db;
  const { id } = row<{ id: string }>(
    db.prepare('SELECT id FROM users WHERE primary_email = ?').get(adminEmail),
  )!;
  const alias = `boss@${adminEmail.split('@')[1]}`;
  db.prepare('INSERT INTO user_aliases (alias, user_id) VALUES (?, ?)').run(
    alias,
    id,
  );
  const tokens: string[] = [];
  for (const subject of [adminEmail.toUpperCase(), alias, id]) {
    const minted = await call('POST', `/domains/${customerId}/tokens`, {
      subject,
    });
    const token = minted.json().access_token as string;
    assert.equal(harness.mock.registry.token(token)?.subject, adminEmail);
    tokens.push(token);
  }
  harness.mock.faults.add(customerId, {
    kind: 'demote-subject',
    subject: adminEmail,
  });
  const byId = await directoryClient(harness, tokens[2])('GET', '/users', {
    query: { customer: 'my_customer' },
  });
  assert.equal(byId.status, 403);
});
