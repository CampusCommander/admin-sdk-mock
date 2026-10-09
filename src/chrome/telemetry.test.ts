import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES } from '../auth/scopes.ts';
import { row } from '../store/sqlite.ts';
import {
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { FilterError, parseTelemetryFilter } from './telemetry-filter.ts';

const SPEC = {
  tier: 'small',
  seed: 'telemetry',
  counts: { schools: 2, students: 100, staff: 20, devices: 400 },
};
const LIST = '/v1/customers/my_customer/telemetry/devices';

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const token = grantToken(harness, domain, READ_SCOPES);
  const request = (path: string, query: Record<string, string | number> = {}) =>
    harness.request({
      host: 'chromemanagement.googleapis.com',
      path,
      token,
      query,
    });
  const count = (where: string) =>
    Number(
      row<{ n: number }>(
        domain.db
          .prepare(`SELECT count(*) AS n FROM devices WHERE ${where}`)
          .get(),
      )?.n,
    );
  return { harness, domain, request, count };
}

test('the filter parser accepts the documented fields', () => {
  const parsed = parseTelemetryFilter(
    'serialNumber="PF123" AND reports_timestamp>=0',
  );
  assert.deepEqual(parsed.sql.where, ['serial_number = ?']);
  assert.deepEqual(parsed.sql.params, ['PF123']);
  assert.equal(parsed.reportsFrom, 0);
  assert.equal(
    parseTelemetryFilter('reports_timestamp>="2026-10-01T00:00:00Z"')
      .reportsFrom,
    Date.parse('2026-10-01T00:00:00Z'),
  );
  assert.deepEqual(parseTelemetryFilter('orgUnitId=03abc').sql.params, [
    'id:03abc',
  ]);
  for (const text of [
    'robot=1',
    'reports_timestamp<5',
    'serialNumber>x',
    'reports_timestamp>=soon',
  ])
    assert.throws(() => parseTelemetryFilter(text), FilterError, text);
});

test('paging lists every device that is not deprovisioned', async (t) => {
  const { request, count } = await setup(t);
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const response = await request(LIST, {
      readMask: 'deviceId',
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    });
    assert.equal(response.status, 200, response.text);
    for (const device of response.json().devices ?? [])
      ids.add(device.deviceId);
    pageToken = response.json().nextPageToken;
  } while (pageToken);
  assert.equal(ids.size, count("status != 'DEPROVISIONED'"));
});

test('pageSize defaults to 100 and clamps at 1000', async (t) => {
  const { request } = await setup(t);
  assert.equal(
    (await request(LIST, { readMask: 'deviceId' })).json().devices.length,
    100,
  );
  assert.ok(
    (await request(LIST, { readMask: 'deviceId', pageSize: 5000 })).json()
      .devices.length <= 1000,
  );
});

test('readMask is required and selects the returned fields', async (t) => {
  const { request } = await setup(t);
  const missing = await request(LIST);
  assert.equal(missing.status, 400);
  assert.equal(missing.json().error.status, 'INVALID_ARGUMENT');
  const device = (
    await request(LIST, { readMask: 'deviceId,serialNumber', pageSize: 1 })
  ).json().devices[0];
  assert.deepEqual(Object.keys(device).sort(), ['deviceId', 'serialNumber']);
});

test('only recent battery reports return without a timestamp filter', async (t) => {
  const { harness, domain, request } = await setup(t);
  const mask = {
    readMask: 'deviceId,batteryInfo,batteryStatusReport',
    pageSize: 50,
  };
  const withBattery = (body: {
    devices: { batteryStatusReport?: unknown[] }[];
  }) => body.devices.filter((device) => device.batteryStatusReport);
  const recent = withBattery((await request(LIST, mask)).json());
  assert.ok(recent.length > 0);
  assert.ok(recent.every((device) => device.batteryStatusReport!.length === 1));
  const all = withBattery(
    (await request(LIST, { ...mask, filter: 'reports_timestamp>=0' })).json(),
  );
  assert.ok(all.every((device) => device.batteryStatusReport!.length === 30));
  harness.mock.domains.updateSettings(domain.customerId, {
    telemetry: { recentReports: 5 },
  });
  const five = withBattery((await request(LIST, mask)).json());
  assert.ok(five.every((device) => device.batteryStatusReport!.length === 5));
});

test('filters select by serial number and OU', async (t) => {
  const { domain, request, count } = await setup(t);
  const sample = row<{ serial_number: string; org_unit_id: string }>(
    domain.db
      .prepare(
        "SELECT serial_number, org_unit_id FROM devices WHERE status = 'ACTIVE' LIMIT 1",
      )
      .get(),
  )!;
  const bySerial = (
    await request(LIST, {
      readMask: 'serialNumber',
      filter: `serialNumber="${sample.serial_number}"`,
    })
  ).json();
  assert.deepEqual(
    bySerial.devices.map(
      (device: { serialNumber: string }) => device.serialNumber,
    ),
    [sample.serial_number],
  );
  const byOu = (
    await request(LIST, {
      readMask: 'deviceId',
      pageSize: 1000,
      filter: `orgUnitId=${sample.org_unit_id.slice(3)}`,
    })
  ).json();
  assert.equal(
    byOu.devices.length,
    count(
      `org_unit_id = '${sample.org_unit_id}' AND status != 'DEPROVISIONED'`,
    ),
  );
  const bad = await request(LIST, { readMask: 'deviceId', filter: 'robot=1' });
  assert.equal(bad.status, 400);
});

test('get returns one device, and 404 for missing or deprovisioned devices', async (t) => {
  const { domain, request } = await setup(t);
  const active = row<{ device_id: string }>(
    domain.db
      .prepare("SELECT device_id FROM devices WHERE status = 'ACTIVE' LIMIT 1")
      .get(),
  )!;
  const found = await request(`${LIST}/${active.device_id}`, {
    readMask: 'name,deviceId',
  });
  assert.equal(found.json().deviceId, active.device_id);
  assert.equal(
    found.json().name,
    `customers/${domain.customerId}/telemetry/devices/${active.device_id}`,
  );
  const missing = await request(`${LIST}/nope`, { readMask: 'deviceId' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.status, 'NOT_FOUND');
  const gone = row<{ device_id: string }>(
    domain.db
      .prepare(
        "SELECT device_id FROM devices WHERE status = 'DEPROVISIONED' LIMIT 1",
      )
      .get(),
  );
  if (gone)
    assert.equal(
      (await request(`${LIST}/${gone.device_id}`, { readMask: 'deviceId' }))
        .status,
      404,
    );
});

test('another customer fails with PERMISSION_DENIED', async (t) => {
  const { request } = await setup(t);
  const response = await request('/v1/customers/C0zzzzzzz/telemetry/devices', {
    readMask: 'deviceId',
  });
  assert.equal(response.status, 403);
  assert.equal(response.json().error.status, 'PERMISSION_DENIED');
});
