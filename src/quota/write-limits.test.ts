import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { batchBody, batchStatuses } from '../testing/batch.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const OUS = '/customer/my_customer/orgunits';

async function setup(t: import('node:test').TestContext, scale = 1) {
  const clock = fakeClock();
  const harness = await startHarness({
    clock,
    timing: { scale, delays: false },
  });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, READ_WRITE_SCOPES);
  const api = directoryClient(harness, token);
  let next = 0;
  const createUser = () =>
    api('POST', '/users', {
      body: {
        primaryEmail: `limit.user${next++}@${domain.spec.primaryDomain}`,
        name: { givenName: 'Limit', familyName: 'User' },
        password: 'correct horse battery',
      },
    });
  const createOu = () =>
    api('POST', OUS, {
      body: { name: `Limit ${next++}`, parentOrgUnitPath: '/' },
    });
  return { clock, harness, domain, token, api, createUser, createOu };
}

const reasonOf = (response: {
  json(): { error: { errors: { reason: string; domain: string }[] } };
}) => response.json().error.errors[0];

test('the eleventh user creation in one second answers 403 rateLimitExceeded', async (t) => {
  const { clock, createUser } = await setup(t);
  for (let n = 0; n < 10; n++)
    assert.equal((await createUser()).status, 200, `user ${n}`);
  const refused = await createUser();
  assert.equal(refused.status, 403);
  assert.deepEqual(reasonOf(refused), {
    message: 'Rate Limit Exceeded',
    domain: 'usageLimits',
    reason: 'rateLimitExceeded',
  });
  await clock.advance(1000);
  assert.equal((await createUser()).status, 200);
});

test('OU creations and updates share one limit, and deletes are not limited', async (t) => {
  const { clock, api, createOu } = await setup(t);
  const created = (await createOu()).json();
  const path = `${OUS}/${encodeURIComponent(created.name)}`;
  assert.equal(
    (await api('PATCH', path, { body: { description: 'x' } })).status,
    403,
  );
  await clock.advance(1000);
  assert.equal(
    (await api('PATCH', path, { body: { description: 'x' } })).status,
    200,
  );
  assert.equal((await api('DELETE', path)).status, 204);
});

test('the time scale shortens the window', async (t) => {
  const { clock, createOu } = await setup(t, 10);
  assert.equal((await createOu()).status, 200);
  assert.equal((await createOu()).status, 403);
  await clock.advance(100);
  assert.equal((await createOu()).status, 200);
});

test('a write that the quota bucket rejects does not use the write limit', async (t) => {
  const { harness, domain, api, createOu } = await setup(t);
  harness.mock.domains.updateSettings(domain.customerId, {
    quota: { perMinute: 2 },
  });
  assert.equal((await api('GET', OUS)).status, 200);
  assert.equal((await api('GET', OUS)).status, 200);
  const refused = await createOu();
  assert.equal(refused.status, 403);
  assert.equal(reasonOf(refused).reason, 'userRateLimitExceeded');
  harness.mock.domains.updateSettings(domain.customerId, {
    quota: { perMinute: 2400 },
  });
  assert.equal((await createOu()).status, 200);
});

test('batch parts pass the write limits one by one', async (t) => {
  const { harness, token } = await setup(t);
  const response = await harness.request({
    host: 'www.googleapis.com',
    method: 'POST',
    path: '/batch/admin/directory_v1',
    token,
    headers: { 'content-type': 'multipart/mixed; boundary=batch' },
    body: batchBody(
      ['a', 'b', 'c'].map((id) => ({
        id,
        method: 'POST',
        path: `/admin/directory/v1${OUS}`,
        body: { name: `Batch ${id}`, parentOrgUnitPath: '/' },
      })),
    ),
  });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(
    [...batchStatuses(response.text).values()].sort(),
    [200, 403, 403],
  );
});
