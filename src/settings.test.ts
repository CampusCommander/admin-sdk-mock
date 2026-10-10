import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  SettingsError,
  withDefaults,
} from './settings.ts';

test('the defaults match the spec', () => {
  assert.equal(DEFAULT_SETTINGS.quota.perMinute, 2400);
  assert.equal(DEFAULT_SETTINGS.quota.ceiling, 1.25);
  assert.equal(DEFAULT_SETTINGS.quota.heavyRatio, 1.125);
  assert.equal(DEFAULT_SETTINGS.quota.overMinutesToFlag, 30);
  assert.equal(DEFAULT_SETTINGS.quota.heavyMinutesToFlag, 10);
  assert.equal(DEFAULT_SETTINGS.quota.flagMinutes, 60);
  assert.equal(DEFAULT_SETTINGS.quota.retryAfter, false);
  assert.equal(DEFAULT_SETTINGS.chromeQuota.perMinute, 2400);
  assert.deepEqual(DEFAULT_SETTINGS.concurrency, {
    perMethod: 40,
    perCustomer: 120,
  });
  assert.equal(DEFAULT_SETTINGS.latency.capMs, 2000);
  assert.equal(DEFAULT_SETTINGS.telemetry.recentReports, 1);
});

test('a patch changes only the named values', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, {
    quota: { perMinute: 100, retryAfter: true },
    latency: { baseMs: 10 },
  });
  assert.equal(merged.quota.perMinute, 100);
  assert.equal(merged.quota.retryAfter, true);
  assert.equal(merged.quota.ceiling, 1.25);
  assert.equal(merged.latency.baseMs, 10);
  assert.equal(DEFAULT_SETTINGS.quota.perMinute, 2400, 'Defaults stay intact.');
});

test('invalid patches fail with a message', () => {
  const bad: unknown[] = [
    'text',
    { quota: 5 },
    { quota: { perMinute: -1 } },
    { quota: { perMinute: 0 } },
    { quota: { robots: 1 } },
    { robots: {} },
    { quota: { retryAfter: 'yes' } },
    { quota: { ceiling: 0.5 } },
    { quota: { heavyRatio: 2 } },
    { quota: { overMinutesToFlag: 1.5 } },
    { latency: { batchParallelism: 0 } },
    { latency: { roundTripP99Ms: 10 } },
    { latency: { bytesPerSecond: 0 } },
    { telemetry: { recentReports: 0 } },
  ];
  for (const patch of bad)
    assert.throws(
      () => mergeSettings(DEFAULT_SETTINGS, patch),
      SettingsError,
      JSON.stringify(patch),
    );
});

test('the write defaults match the milestone 2 spec', () => {
  assert.deepEqual(DEFAULT_SETTINGS.writes, {
    searchDelaySeconds: 300,
    commandExpirySeconds: 432_000,
    userCreatesPerSecond: 10,
    orgUnitWritesPerSecond: 1,
  });
  assert.equal(DEFAULT_SETTINGS.latency.writeBaseMs, 250);
  assert.equal(DEFAULT_SETTINGS.latency.perDeviceWriteMs, 10);
});

test('write settings validate their ranges', () => {
  assert.equal(
    mergeSettings(DEFAULT_SETTINGS, { writes: { searchDelaySeconds: 0 } })
      .writes.searchDelaySeconds,
    0,
  );
  assert.throws(
    () =>
      mergeSettings(DEFAULT_SETTINGS, { writes: { commandExpirySeconds: 0 } }),
    /writes.commandExpirySeconds must be 1 or more/,
  );
  assert.throws(
    () =>
      mergeSettings(DEFAULT_SETTINGS, {
        writes: { userCreatesPerSecond: 1.5 },
      }),
    /writes.userCreatesPerSecond must be a whole number of 1 or more/,
  );
  assert.throws(
    () =>
      mergeSettings(DEFAULT_SETTINGS, {
        writes: { orgUnitWritesPerSecond: 0 },
      }),
    /writes.orgUnitWritesPerSecond must be a whole number of 1 or more/,
  );
});

test('stored settings from milestone 1 read back with the write defaults', () => {
  const stored = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  delete stored.writes;
  delete stored.latency.writeBaseMs;
  assert.deepEqual(withDefaults(stored), DEFAULT_SETTINGS);
});
