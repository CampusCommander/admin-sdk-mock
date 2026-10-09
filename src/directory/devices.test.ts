import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES } from '../auth/scopes.ts';
import { NO_OVERRIDES } from '../http/types.ts';
import { buildLayout } from '../seed/layout.ts';
import { row, rows } from '../store/sqlite.ts';
import {
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const SPEC = {
  tier: 'small',
  seed: 'devices',
  layout: 'role-first',
  counts: { schools: 2, students: 300, staff: 40, devices: 700 },
};
const LIST = '/admin/directory/v1/customer/my_customer/devices/chromeos';

interface Device {
  deviceId: string;
  serialNumber: string;
  lastSync: string;
  recentUsers?: unknown[];
  activeTimeRanges?: unknown[];
}

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const token = grantToken(harness, domain, READ_SCOPES);
  const list = (query: Record<string, string | number> = {}) =>
    harness.request({ host: 'admin.googleapis.com', path: LIST, token, query });
  const all = async (query: Record<string, string | number> = {}) => {
    const devices: Device[] = [];
    let pageToken: string | undefined;
    do {
      const response = await list({
        ...query,
        ...(pageToken ? { pageToken } : {}),
      });
      assert.equal(response.status, 200, response.text);
      const body = response.json();
      devices.push(...(body.chromeosdevices ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return devices;
  };
  const count = (where: string) =>
    Number(
      row<{ n: number }>(
        domain.db
          .prepare(`SELECT count(*) AS n FROM devices WHERE ${where}`)
          .get(),
      )?.n,
    );
  return { harness, domain, token, list, all, count };
}

test('paging returns every device exactly once', async (t) => {
  const { all, list } = await setup(t);
  const devices = await all();
  assert.equal(devices.length, 700);
  assert.equal(new Set(devices.map((device) => device.deviceId)).size, 700);
  assert.equal((await list()).json().chromeosdevices.length, 100);
});

test('maxResults clamps at 300 and rejects values below 1', async (t) => {
  const { list } = await setup(t);
  assert.equal(
    (await list({ maxResults: 300 })).json().chromeosdevices.length,
    300,
  );
  assert.equal(
    (await list({ maxResults: 301 })).json().chromeosdevices.length,
    300,
  );
  assert.equal((await list({ maxResults: 0 })).status, 400);
  assert.equal((await list({ maxResults: 'abc' })).status, 400);
});

test('ordering holds across pages in both directions', async (t) => {
  const { all } = await setup(t);
  const ascending = await all({ orderBy: 'SERIAL_NUMBER', maxResults: 250 });
  const serials = ascending.map((device) => device.serialNumber);
  assert.deepEqual(serials, [...serials].sort());
  const descending = await all({
    orderBy: 'lastSync',
    sortOrder: 'DESCENDING',
    maxResults: 250,
  });
  assert.equal(descending.length, 700);
  for (let i = 1; i < descending.length; i++)
    assert.ok(descending[i - 1].lastSync >= descending[i].lastSync);
});

test('orgUnitPath selects one OU or its subtree', async (t) => {
  const { all, count, domain, list } = await setup(t);
  const school = buildLayout(domain.spec).schools[0];
  const container = school.deviceOus.cart.split('/').slice(0, -1).join('/');
  assert.equal((await all({ orgUnitPath: container.slice(1) })).length, 0);
  const subtree = await all({
    orgUnitPath: container.slice(1),
    includeChildOrgunits: 'true',
  });
  assert.equal(subtree.length, count(`org_unit_path LIKE '${container}/%'`));
  assert.ok(subtree.length > 0);
  assert.equal((await list({ includeChildOrgunits: 'true' })).status, 400);
});

test('query operators match the stored data', async (t) => {
  const { all, count, domain, list } = await setup(t);
  assert.equal(
    (await all({ query: 'status:disabled' })).length,
    count("status = 'DISABLED'"),
  );
  const sample = row<{
    serial_number: string;
    device_id: string;
    annotated_asset_id: string;
  }>(
    domain.db
      .prepare(
        'SELECT serial_number, device_id, annotated_asset_id FROM devices WHERE annotated_asset_id IS NOT NULL LIMIT 1',
      )
      .get(),
  )!;
  const bySerial = await all({
    query: `id:${sample.serial_number.slice(0, 5)}`,
  });
  assert.ok(bySerial.some((device) => device.deviceId === sample.device_id));
  const byText = await all({ query: sample.annotated_asset_id });
  assert.ok(byText.some((device) => device.deviceId === sample.device_id));
  const since = new Date(domain.record.seededAt - 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  assert.equal(
    (await all({ query: `sync:${since}..` })).length,
    count(`last_sync >= ${Date.parse(`${since}T00:00:00Z`)}`),
  );
  assert.equal((await list({ query: 'robots:1' })).status, 400);
});

test('projection BASIC drops the report arrays', async (t) => {
  const { list } = await setup(t);
  const full = (
    await list({ query: 'status:provisioned', maxResults: 50 })
  ).json().chromeosdevices as Device[];
  assert.ok(full.some((device) => device.activeTimeRanges));
  assert.ok(full.some((device) => device.recentUsers));
  const basic = (
    await list({
      query: 'status:provisioned',
      maxResults: 50,
      projection: 'BASIC',
    })
  ).json().chromeosdevices as Device[];
  assert.ok(
    basic.every((device) => !device.activeTimeRanges && !device.recentUsers),
  );
});

test('get returns one device or the Google not-found error', async (t) => {
  const { harness, token, domain } = await setup(t);
  const id = rows<{ device_id: string }>(
    domain.db.prepare('SELECT device_id FROM devices LIMIT 1').all(),
  )[0].device_id;
  const found = await harness.request({
    host: 'admin.googleapis.com',
    path: `${LIST}/${id}`,
    token,
  });
  assert.equal(found.json().deviceId, id);
  const missing = await harness.request({
    host: 'admin.googleapis.com',
    path: `${LIST}/nope`,
    token,
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.message, 'Resource Not Found: deviceId');
});

test('hidden devices disappear from lists and gets', async (t) => {
  const { harness, token, domain, all } = await setup(t);
  const id = rows<{ device_id: string }>(
    domain.db.prepare('SELECT device_id FROM devices LIMIT 1').all(),
  )[0].device_id;
  harness.mock.overrides = { ...NO_OVERRIDES, hidden: () => new Set([id]) };
  const devices = await all();
  assert.equal(devices.length, 699);
  const response = await harness.request({
    host: 'admin.googleapis.com',
    path: `${LIST}/${id}`,
    token,
  });
  assert.equal(response.status, 404);
});

test('a page token fails for another query and after a reset', async (t) => {
  const { harness, domain, list } = await setup(t);
  const token = (await list({ query: 'status:provisioned' })).json()
    .nextPageToken as string;
  assert.equal(
    (await list({ query: 'status:disabled', pageToken: token })).status,
    400,
  );
  harness.mock.domains.reset(domain.customerId, domain.record.seededAt + 1);
  assert.equal(
    (await list({ query: 'status:provisioned', pageToken: token })).status,
    400,
  );
});

test('fields trims each device', async (t) => {
  const { list } = await setup(t);
  const body = (
    await list({
      fields: 'chromeosdevices(deviceId,serialNumber),nextPageToken',
    })
  ).json();
  assert.deepEqual(Object.keys(body).sort(), [
    'chromeosdevices',
    'nextPageToken',
  ]);
  assert.deepEqual(Object.keys(body.chromeosdevices[0]).sort(), [
    'deviceId',
    'serialNumber',
  ]);
});
