import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { issueServiceAccount } from '../auth/accounts.ts';
import { READ_SCOPES, SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { rows } from '../store/sqlite.ts';
import {
  adminOf,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { signAssertion, tokenRequestBody } from '../testing/jwt.ts';
import { FaultError } from './faults.ts';

const ORGUNITS = '/admin/directory/v1/customer/my_customer/orgunits';

async function setup(t: import('node:test').TestContext, clock = fakeClock()) {
  const harness = await startHarness({ clock });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, READ_SCOPES);
  const get = (
    path = ORGUNITS,
    host = 'admin.googleapis.com',
    query?: Record<string, string>,
  ) => harness.request({ host, path, token, query });
  const add = (rule: unknown) =>
    harness.mock.faults.add(domain.customerId, rule);
  return { clock, harness, domain, token, get, add };
}

test('a status fault answers the next N matching calls', async (t) => {
  const { get, add } = await setup(t);
  add({
    kind: 'status',
    method: 'directory.orgunits.list',
    status: 503,
    reason: 'backendError',
    count: 2,
  });
  assert.equal(
    (await get('/admin/directory/v1/customer/my_customer/domains')).status,
    200,
  );
  const first = await get();
  assert.equal(first.status, 503);
  assert.equal(first.json().error.errors[0].reason, 'backendError');
  assert.equal((await get()).status, 503);
  assert.equal((await get()).status, 200);
});

test('a Chrome status fault uses the RPC envelope', async (t) => {
  const { get, add } = await setup(t);
  add({ kind: 'status', status: 429, reason: 'RESOURCE_EXHAUSTED', count: 1 });
  const response = await get(
    '/v1/customers/my_customer/telemetry/devices',
    'chromemanagement.googleapis.com',
    { readMask: 'deviceId' },
  );
  assert.equal(response.status, 429);
  assert.equal(response.json().error.status, 'RESOURCE_EXHAUSTED');
});

test('a reset fault closes the connection once', async (t) => {
  const { get, add } = await setup(t);
  add({ kind: 'reset', count: 1 });
  await assert.rejects(get(), /socket hang up|ECONNRESET/);
  assert.equal((await get()).status, 200);
});

test('a hang fault holds the response for the scaled duration', async (t) => {
  const { get, add, clock } = await setup(t);
  add({ kind: 'hang', ms: 5000, count: 1 });
  let done = false;
  const pending = get().then((response) => {
    done = true;
    return response;
  });
  for (let i = 0; i < 1000 && clock.pending() === 0; i++) await tick();
  await clock.advance(4000);
  await tick();
  assert.equal(done, false);
  await clock.advance(1000);
  assert.equal((await pending).status, 200);
});

test('an error rate of 1 always fails and 0 never fails', async (t) => {
  const { get, add, harness, domain } = await setup(t);
  add({ kind: 'error-rate', rate: 1 });
  const statuses = new Set<number>();
  for (let i = 0; i < 60; i++) statuses.add((await get()).status);
  assert.deepEqual([...statuses].sort(), [500, 503]);
  harness.mock.faults.clear(domain.customerId);
  add({ kind: 'error-rate', rate: 0 });
  assert.equal((await get()).status, 200);
});

test('revoked delegation and removed scopes fail the token exchange until cleared', async (t) => {
  const { harness, domain, add } = await setup(t, undefined);
  const account = issueServiceAccount(harness.mock.registry, domain.customerId);
  harness.mock.registry.setGrant(domain.customerId, account.client_id, [
    SCOPES.orgunit[1],
    SCOPES.device[1],
  ]);
  const exchange = (scope: string) =>
    harness.request({
      host: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      body: tokenRequestBody(
        signAssertion(
          account,
          { scope, sub: adminOf(domain) },
          harness.mock.clock.now(),
        ),
      ),
    });
  add({
    kind: 'remove-scope',
    clientId: account.client_id,
    scope: SCOPES.device[1],
  });
  assert.equal((await exchange(SCOPES.orgunit[1])).status, 200);
  assert.equal(
    (await exchange(SCOPES.device[1])).json().error,
    'unauthorized_client',
  );
  add({ kind: 'revoke-delegation', clientId: account.client_id });
  assert.equal(
    (await exchange(SCOPES.orgunit[1])).json().error,
    'unauthorized_client',
  );
  harness.mock.faults.clear(domain.customerId);
  assert.equal((await exchange(SCOPES.device[1])).status, 200);
});

test('a demoted subject loses administrator access', async (t) => {
  const { get, add, domain } = await setup(t);
  add({ kind: 'demote-subject', subject: adminOf(domain) });
  const response = await get();
  assert.equal(response.status, 403);
  assert.equal(response.json().error.errors[0].reason, 'forbidden');
});

test('a removed device disappears from gets and lists', async (t) => {
  const { harness, domain, token, add } = await setup(t);
  const id = rows<{ device_id: string }>(
    domain.db.prepare('SELECT device_id FROM devices LIMIT 1').all(),
  )[0].device_id;
  add({ kind: 'remove-entity', entityId: id });
  const response = await harness.request({
    host: 'admin.googleapis.com',
    path: `/admin/directory/v1/customer/my_customer/devices/chromeos/${id}`,
    token,
  });
  assert.equal(response.status, 404);
});

test('invalid rules fail and the list shows stored rules', async (t) => {
  const { harness, domain, add } = await setup(t);
  for (const rule of [
    null,
    { kind: 'meteor' },
    { kind: 'status', status: 200, reason: 'x', count: 1 },
    { kind: 'status', status: 503, reason: '', count: 1 },
    { kind: 'error-rate', rate: 2 },
    { kind: 'hang', ms: 0, count: 1 },
    { kind: 'reset', count: 0 },
    { kind: 'revoke-delegation', clientId: 'abc' },
    { kind: 'remove-scope', clientId: '1', scope: 'scope' },
    { kind: 'status', status: 503, reason: 'x', count: 1, extra: true },
  ])
    assert.throws(() => add(rule), FaultError, JSON.stringify(rule));
  const id = add({ kind: 'reset', count: 3 });
  assert.deepEqual(harness.mock.faults.list(domain.customerId), [
    { id, rule: { kind: 'reset', count: 3 }, remaining: 3 },
  ]);
  harness.mock.faults.clear(domain.customerId);
  assert.deepEqual(harness.mock.faults.list(domain.customerId), []);
});

test('a fault must name a directory or Chrome route ID', async (t) => {
  const { add } = await setup(t);
  for (const method of [
    'chromeosdevices.list',
    'oauth.token',
    'batch.directory',
    'oauth.tokeninfo',
  ])
    assert.throws(
      () => add({ kind: 'status', method, status: 503, reason: 'x', count: 1 }),
      /method must be one of: .*directory\.orgunits\.list/,
      method,
    );
  assert.throws(
    () => add({ kind: 'hang', method: 'batch.directory', ms: 5, count: 1 }),
    FaultError,
  );
  assert.doesNotThrow(() =>
    add({
      kind: 'status',
      method: 'chrome.telemetry.devices.list',
      status: 503,
      reason: 'x',
      count: 1,
    }),
  );
  assert.doesNotThrow(() => add({ kind: 'reset', count: 1 }));
});
