import assert from 'node:assert/strict';
import test from 'node:test';
import { openDomainDb } from '../store/domain-db.ts';
import { rows } from '../store/sqlite.ts';
import type { StoredDevice } from './devices.ts';
import {
  batteryHealth,
  batteryTelemetry,
  deviceReports,
  REPORT_DAYS,
} from './reports.ts';
import { seedDomain } from './seed.ts';
import { resolveSpec } from './spec.ts';

const db = openDomainDb(':memory:');
seedDomain(
  db,
  resolveSpec({ tier: 'small', seed: 'reports', counts: { devices: 2000 } }),
  Date.UTC(2026, 9, 9, 12),
);
const devices = rows<StoredDevice>(
  db.prepare("SELECT * FROM devices WHERE status = 'ACTIVE'").all(),
);

test('reports are identical on every read', () => {
  const device = devices[0];
  assert.deepEqual(
    deviceReports('reports', device),
    deviceReports('reports', device),
  );
  assert.deepEqual(
    batteryTelemetry('reports', device),
    batteryTelemetry('reports', device),
  );
});

test('the FULL report arrays are present', () => {
  const reports = deviceReports('reports', devices[0]);
  for (const key of [
    'activeTimeRanges',
    'cpuStatusReports',
    'diskVolumeReports',
    'systemRamFreeReports',
    'lastKnownNetwork',
    'cpuInfo',
    'diskSpaceUsage',
    'tpmVersionInfo',
  ])
    assert.ok(key in reports, key);
});

test('recent users come from the stored list', () => {
  const device = devices.find((entry) => entry.recent_users !== null)!;
  const reports = deviceReports('reports', device) as {
    recentUsers: { email: string }[];
  };
  assert.deepEqual(
    reports.recentUsers.map((user) => user.email),
    JSON.parse(device.recent_users!),
  );
});

test('battery reports run oldest first and match their health class', () => {
  const telemetry = batteryTelemetry(
    'reports',
    devices.find((entry) => entry.has_battery === 1)!,
  )!;
  const reports = telemetry.batteryStatusReport as {
    reportTime: string;
    fullChargeCapacity: string;
    batteryHealth: string;
  }[];
  assert.equal(reports.length, REPORT_DAYS);
  const design = Number(
    (telemetry.batteryInfo[0] as { designCapacity: string }).designCapacity,
  );
  for (let i = 1; i < reports.length; i++)
    assert.ok(reports[i].reportTime > reports[i - 1].reportTime);
  for (const report of reports)
    assert.equal(
      report.batteryHealth,
      batteryHealth(Number(report.fullChargeCapacity) / design),
    );
});

test('devices without a battery report no battery telemetry', () => {
  const device = devices.find((entry) => entry.has_battery === 0);
  assert.ok(device, 'The seed includes a device without a battery.');
  assert.equal(batteryTelemetry('reports', device), null);
});

test('the fleet covers every battery health class', () => {
  const classes = new Set(
    devices
      .map((device) => batteryTelemetry('reports', device))
      .filter((telemetry) => telemetry !== null)
      .map(
        (telemetry) =>
          (telemetry.batteryStatusReport.at(-1) as { batteryHealth: string })
            .batteryHealth,
      ),
  );
  assert.deepEqual([...classes].sort(), [
    'BATTERY_HEALTH_NORMAL',
    'BATTERY_REPLACE_NOW',
    'BATTERY_REPLACE_SOON',
  ]);
});
