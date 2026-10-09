import assert from 'node:assert/strict';
import test from 'node:test';
import { QuotaBucket, type QuotaRules } from './bucket.ts';

const RULES: QuotaRules = {
  perMinute: 100,
  ceiling: 1.25,
  heavyRatio: 1.125,
  overMinutesToFlag: 30,
  heavyMinutesToFlag: 10,
  flagMinutes: 60,
};
const MINUTE = 1000;

/** Send `attempts` requests inside one minute and return how many it admits. */
function drive(bucket: QuotaBucket, minute: number, attempts: number): number {
  let admitted = 0;
  for (let i = 0; i < attempts; i++)
    if (bucket.admit(minute * MINUTE + (i % (MINUTE - 1)))) admitted++;
  return admitted;
}

const fresh = () => new QuotaBucket(RULES, MINUTE);

test('an unflagged minute admits up to the 125% ceiling', () => {
  assert.equal(drive(fresh(), 0, 200), 125);
});

test('short bursts once or twice an hour cause no flag', () => {
  const bucket = fresh();
  let minute = 0;
  for (let i = 0; i < 10; i++) assert.equal(drive(bucket, minute++, 110), 110);
  for (let i = 0; i < 50; i++) drive(bucket, minute++, 100);
  for (let i = 0; i < 10; i++) assert.equal(drive(bucket, minute++, 110), 110);
  assert.equal(bucket.snapshot(minute * MINUTE).flagged, false);
});

test('30 over minutes flag the bucket for 60 minutes, then admission recovers', () => {
  const bucket = fresh();
  for (let minute = 0; minute < 30; minute++)
    assert.equal(drive(bucket, minute, 110), 110);
  assert.equal(
    drive(bucket, 30, 110),
    100,
    'The flag caps the next minute at 100%.',
  );
  const snapshot = bucket.snapshot(30 * MINUTE + 500);
  assert.equal(snapshot.flagged, true);
  assert.equal(snapshot.flaggedUntil, 90 * MINUTE);
  assert.equal(snapshot.limit, 100);
  assert.equal(drive(bucket, 89, 200), 100);
  assert.equal(drive(bucket, 90, 200), 125, 'The flag ends after 60 minutes.');
  assert.equal(bucket.snapshot(91 * MINUTE).flagged, false);
});

test('10 heavy minutes flag the bucket and 9 do not', () => {
  const bucket = fresh();
  for (let minute = 0; minute < 9; minute++) drive(bucket, minute, 120);
  drive(bucket, 9, 1);
  assert.equal(bucket.snapshot(9 * MINUTE + 1).flagged, false);
  const second = fresh();
  for (let minute = 0; minute < 10; minute++) drive(second, minute, 120);
  drive(second, 10, 1);
  assert.equal(second.snapshot(10 * MINUTE + 1).flagged, true);
});

test('over minutes older than 60 minutes drop out of the count', () => {
  const bucket = fresh();
  for (let minute = 0; minute < 29; minute++) drive(bucket, minute, 110);
  for (let minute = 29; minute < 60; minute++) drive(bucket, minute, 50);
  drive(bucket, 60, 110);
  drive(bucket, 61, 1);
  const snapshot = bucket.snapshot(61 * MINUTE + 1);
  assert.equal(snapshot.flagged, false);
  assert.equal(snapshot.overMinutes, 29);
});

test('retryAfterMs reports the time to the next minute', () => {
  const bucket = fresh();
  bucket.admit(5 * MINUTE + 300);
  assert.equal(bucket.retryAfterMs(5 * MINUTE + 300), 700);
});
