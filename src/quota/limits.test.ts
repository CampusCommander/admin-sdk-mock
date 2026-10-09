import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import type { Call } from '../http/types.ts';
import {
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { createLimits } from './limits.ts';

async function setup(t: import('node:test').TestContext, perMinute = 4) {
  const clock = fakeClock();
  const harness = await startHarness({ clock });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  harness.mock.domains.updateSettings(domain.customerId, {
    quota: { perMinute },
    chromeQuota: { perMinute },
  });
  const token = grantToken(harness, domain, READ_SCOPES);
  const orgunits = () =>
    harness.request({
      host: 'admin.googleapis.com',
      path: '/admin/directory/v1/customer/my_customer/orgunits',
      token,
    });
  return { clock, harness, domain, token, orgunits };
}

test('a Directory bucket rejects with 403 userRateLimitExceeded above the ceiling', async (t) => {
  const { orgunits, clock } = await setup(t);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await orgunits()).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 403]);
  const rejected = await orgunits();
  assert.equal(rejected.json().error.errors[0].reason, 'userRateLimitExceeded');
  assert.equal(rejected.json().error.errors[0].domain, 'usageLimits');
  assert.equal(rejected.headers['retry-after'], undefined);
  await clock.advance(60_000);
  assert.equal((await orgunits()).status, 200, 'A new minute admits again.');
});

test('Retry-After appears when the setting enables it', async (t) => {
  const { orgunits, harness, domain } = await setup(t);
  harness.mock.domains.updateSettings(domain.customerId, {
    quota: { retryAfter: true },
  });
  for (let i = 0; i < 5; i++) await orgunits();
  const rejected = await orgunits();
  assert.equal(rejected.status, 403);
  assert.ok(Number(rejected.headers['retry-after']) >= 1);
});

test('Chrome Management rejects with 429 RESOURCE_EXHAUSTED', async (t) => {
  const { harness, token } = await setup(t);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++)
    statuses.push(
      (
        await harness.request({
          host: 'chromemanagement.googleapis.com',
          path: '/v1/customers/my_customer/telemetry/devices',
          query: { readMask: 'deviceId' },
          token,
        })
      ).status,
    );
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
});

test('each batch part counts against the quota', async (t) => {
  const { harness, token } = await setup(t);
  const part = (id: number) =>
    `--b\r\nContent-Type: application/http\r\nContent-ID: <p${id}>\r\n\r\nGET /admin/directory/v1/customer/my_customer/orgunits\r\n\r\n`;
  const response = await harness.request({
    host: 'www.googleapis.com',
    path: '/batch/admin/directory_v1',
    method: 'POST',
    token,
    headers: { 'content-type': 'multipart/mixed; boundary=b' },
    body: Array.from({ length: 8 }, (_, i) => part(i)).join('') + '--b--\r\n',
  });
  const statuses = [...response.text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(
    (match) => Number(match[1]),
  );
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 403, 403, 403]);
});

test('the report shows the bucket and its count', async (t) => {
  const { orgunits, harness, domain } = await setup(t);
  await orgunits();
  const report = harness.mock.limits.report(domain.customerId);
  assert.equal(report.buckets.length, 1);
  assert.equal(report.buckets[0].snapshot.count, 1);
  assert.equal(report.buckets[0].snapshot.limit, 5);
});

test('concurrency caps reject in-flight requests until release', async (t) => {
  const { harness, domain, token } = await setup(t, 1000);
  harness.mock.domains.updateSettings(domain.customerId, {
    concurrency: { perMethod: 1, perCustomer: 2 },
  });
  const call = (id: string) =>
    ({
      route: { id, api: 'directory' },
      access: {
        customerId: domain.customerId,
        subject: 'admin',
        token: { projectId: 'p', token },
      },
      domain: harness.mock.domains.get(domain.customerId),
    }) as unknown as Call;
  const limits = createLimits({
    clock: harness.mock.clock,
    timing: harness.mock.timing,
  });
  const first = limits.admit(call('m1'));
  assert.ok(first.ok);
  const sameMethod = limits.admit(call('m1'));
  assert.equal(!sameMethod.ok && sameMethod.response.status, 403);
  const second = limits.admit(call('m2'));
  assert.ok(second.ok);
  const thirdMethod = limits.admit(call('m3'));
  assert.equal(!thirdMethod.ok && thirdMethod.response.status, 429);
  if (first.ok) first.release();
  assert.ok(limits.admit(call('m1')).ok);
  assert.equal(limits.inFlight(domain.customerId), 2);
});

test('a time-scale change starts fresh buckets', async (t) => {
  const { orgunits, harness, domain } = await setup(t);
  for (let i = 0; i < 5; i++) await orgunits();
  assert.equal((await orgunits()).status, 403);
  harness.mock.timing.scale = 60;
  assert.equal((await orgunits()).status, 200);
  assert.equal(
    harness.mock.limits.report(domain.customerId).buckets[0].snapshot.count,
    1,
  );
});

test('toggling Retry-After keeps the bucket', async (t) => {
  const { orgunits, harness, domain } = await setup(t);
  for (let i = 0; i < 3; i++) await orgunits();
  harness.mock.domains.updateSettings(domain.customerId, {
    quota: { retryAfter: true },
  });
  await orgunits();
  const report = harness.mock.limits.report(domain.customerId);
  assert.equal(report.buckets.length, 1);
  assert.equal(report.buckets[0].snapshot.count, 4);
});
