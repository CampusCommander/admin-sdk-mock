import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { READ_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import {
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

async function waitForSleeper(clock: ReturnType<typeof fakeClock>) {
  for (let i = 0; i < 1000 && clock.pending() === 0; i++) await tick();
  assert.equal(clock.pending(), 1, 'The response waits on one delay.');
}

test('a response waits for the modeled delay', async (t) => {
  const clock = fakeClock();
  const harness = await startHarness({
    clock,
    timing: { scale: 1, delays: true },
  });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, READ_SCOPES);
  let done = false;
  const pending = harness
    .request({
      host: 'admin.googleapis.com',
      path: '/admin/directory/v1/customer/my_customer/orgunits',
      token,
    })
    .then((response) => {
      done = true;
      return response;
    });
  await waitForSleeper(clock);
  await clock.advance(100);
  await tick();
  assert.equal(done, false, 'The delay exceeds 100 ms.');
  await clock.advance(2000);
  assert.equal((await pending).status, 200);
});

test('the time scale divides the delay', async (t) => {
  const clock = fakeClock();
  const harness = await startHarness({
    clock,
    timing: { scale: 100, delays: true },
  });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, READ_SCOPES);
  const pending = harness.request({
    host: 'admin.googleapis.com',
    path: '/admin/directory/v1/customer/my_customer/orgunits',
    token,
  });
  await waitForSleeper(clock);
  await clock.advance(21);
  assert.equal(
    (await pending).status,
    200,
    'A capped 2 s delay at scale 100 ends within 21 ms.',
  );
});

test('no delay applies when delays are off', async (t) => {
  const clock = fakeClock();
  const harness = await startHarness({
    clock,
    timing: { scale: 1, delays: false },
  });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, READ_SCOPES);
  const response = await harness.request({
    host: 'admin.googleapis.com',
    path: '/admin/directory/v1/customer/my_customer/orgunits',
    token,
  });
  assert.equal(response.status, 200);
  assert.equal(clock.pending(), 0);
});
