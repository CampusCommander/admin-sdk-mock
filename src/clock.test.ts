import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeClock, parseTiming, systemClock, TimingError } from './clock.ts';

test('a fake sleep resolves only after the clock advances past it', async () => {
  const clock = fakeClock(1_000);
  let done = false;
  const sleeping = clock.sleep(500).then(() => {
    done = true;
  });
  await clock.advance(499);
  assert.equal(done, false);
  await clock.advance(1);
  await sleeping;
  assert.equal(done, true);
  assert.equal(clock.now(), 1_500);
});

test('fake sleepers wake in time order', async () => {
  const clock = fakeClock(0);
  const order: number[] = [];
  const late = clock.sleep(30).then(() => order.push(30));
  const early = clock.sleep(10).then(() => order.push(10));
  await clock.advance(100);
  await Promise.all([late, early]);
  assert.deepEqual(order, [10, 30]);
  assert.equal(clock.pending(), 0);
});

test('a zero sleep resolves at once on both clocks', async () => {
  await systemClock.sleep(0);
  await fakeClock().sleep(0);
});

test('parseTiming applies defaults and rejects bad values', () => {
  assert.deepEqual(parseTiming(undefined, undefined), {
    scale: 1,
    delays: true,
  });
  assert.deepEqual(parseTiming('60', 'off'), { scale: 60, delays: false });
  assert.deepEqual(parseTiming('1', 'false'), { scale: 1, delays: false });
  assert.throws(() => parseTiming('0', undefined), TimingError);
  assert.throws(() => parseTiming('abc', undefined), TimingError);
  assert.throws(() => parseTiming('200000', undefined), TimingError);
  assert.throws(() => parseTiming('1', 'maybe'), TimingError);
});
