import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { row, rows } from '../store/sqlite.ts';
import { batchBody, batchStatuses } from '../testing/batch.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const D = 300_000;
const DEVICES = '/customer/my_customer/devices/chromeos';

async function setup(t: import('node:test').TestContext) {
  const clock = fakeClock();
  const harness = await startHarness({ clock });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, READ_WRITE_SCOPES);
  const api = directoryClient(harness, token);
  const active = rows<{
    device_id: string;
    org_unit_path: string;
    org_unit_id: string;
  }>(
    domain.db
      .prepare(
        "SELECT device_id, org_unit_path, org_unit_id FROM devices WHERE status = 'ACTIVE' ORDER BY ord LIMIT 5",
      )
      .all(),
  );
  const target = row<{ path: string; org_unit_id: string }>(
    domain.db
      .prepare(
        "SELECT path, org_unit_id FROM orgunits WHERE path != '/' AND path NOT IN (SELECT org_unit_path FROM devices) ORDER BY ord LIMIT 1",
      )
      .get(),
  )!;
  const listedUnder = async (path: string) =>
    (
      (
        await api('GET', DEVICES, {
          query: { orgUnitPath: path, maxResults: 300 },
        })
      ).json().chromeosdevices ?? []
    )
      .map((device: { deviceId: string }) => device.deviceId)
      .sort();
  const get = async (id: string) =>
    (await api('GET', `${DEVICES}/${id}`)).json();
  return {
    clock,
    harness,
    domain,
    token,
    api,
    active,
    target,
    listedUnder,
    get,
  };
}

test('patch changes only the fields in the body and returns a new etag', async (t) => {
  const { api, active, get } = await setup(t);
  const id = active[0].device_id;
  const before = await get(id);
  const response = await api('PATCH', `${DEVICES}/${id}`, {
    body: { annotatedLocation: 'Room 12', serialNumber: 'IGNORED' },
  });
  assert.equal(response.status, 200, response.text);
  const body = response.json();
  assert.equal(body.annotatedLocation, 'Room 12');
  assert.equal(body.serialNumber, before.serialNumber);
  assert.equal(body.annotatedUser, before.annotatedUser);
  assert.notEqual(body.etag, before.etag);
  assert.equal((await get(id)).annotatedLocation, 'Room 12');
});

test('update behaves like patch, and an empty string clears a field', async (t) => {
  const { api, active, get } = await setup(t);
  const id = active[0].device_id;
  const before = await get(id);
  assert.equal(
    (await api('PUT', `${DEVICES}/${id}`, { body: { notes: 'Cracked' } }))
      .status,
    200,
  );
  const after = await get(id);
  assert.equal(after.notes, 'Cracked');
  assert.equal(after.annotatedLocation, before.annotatedLocation);
  await api('PUT', `${DEVICES}/${id}`, { body: { notes: '' } });
  assert.equal((await get(id)).notes, undefined);
});

test('field limits, field types, unknown OUs, and malformed JSON return 400', async (t) => {
  const { api, active, get } = await setup(t);
  const id = active[0].device_id;
  const before = await get(id);
  for (const body of [
    { annotatedUser: 'u'.repeat(101) },
    { annotatedLocation: 'l'.repeat(201) },
    { notes: 'n'.repeat(501) },
    { notes: 5 },
    { orgUnitPath: '/No/Such/Unit' },
    '{',
  ]) {
    const response = await api('PATCH', `${DEVICES}/${id}`, { body });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await get(id)).etag, before.etag);
  assert.equal(
    (
      await api('PATCH', `${DEVICES}/${id}`, {
        body: { annotatedUser: 'u'.repeat(100), notes: 'n'.repeat(500) },
      })
    ).status,
    200,
  );
});

test('orgUnitPath and orgUnitId move a device, and lists lag the move', async (t) => {
  const { clock, api, active, target, listedUnder } = await setup(t);
  const [first, second] = active.map((device) => device.device_id);
  const moved = await api('PATCH', `${DEVICES}/${first}`, {
    body: { orgUnitPath: target.path },
  });
  assert.equal(moved.json().orgUnitPath, target.path);
  assert.deepEqual(await listedUnder(target.path), []);
  await clock.advance(D);
  assert.deepEqual(await listedUnder(target.path), [first]);
  const byId = await api('PATCH', `${DEVICES}/${second}`, {
    body: { orgUnitId: target.org_unit_id.replace(/^id:/, '') },
  });
  assert.equal(byId.json().orgUnitPath, target.path);
});

test('moveDevicesToOu moves the listed devices and lists lag the move', async (t) => {
  const { clock, api, active, target, listedUnder, get } = await setup(t);
  const ids = active.slice(0, 3).map((device) => device.device_id);
  const response = await api('POST', `${DEVICES}/moveDevicesToOu`, {
    query: { orgUnitPath: target.path },
    body: { deviceIds: ids },
  });
  assert.equal(response.status, 204, response.text);
  assert.equal(response.text, '');
  for (const id of ids) assert.equal((await get(id)).orgUnitPath, target.path);
  assert.deepEqual(await listedUnder(target.path), []);
  await clock.advance(D);
  assert.deepEqual(await listedUnder(target.path), [...ids].sort());
  const byId = await api('POST', `${DEVICES}/moveDevicesToOu`, {
    query: { orgUnitPath: active[0].org_unit_id },
    body: { deviceIds: [ids[0]] },
  });
  assert.equal(byId.status, 204, byId.text);
  assert.equal((await get(ids[0])).orgUnitPath, active[0].org_unit_path);
});

test('moveDevicesToOu rejects bad requests and moves nothing', async (t) => {
  const { api, active, target, get } = await setup(t);
  const id = active[0].device_id;
  const move = (query: Record<string, string>, body: unknown) =>
    api('POST', `${DEVICES}/moveDevicesToOu`, { query, body });
  const cases: [Record<string, string>, unknown][] = [
    [{}, { deviceIds: [id] }],
    [{ orgUnitPath: '/No/Such/Unit' }, { deviceIds: [id] }],
    [{ orgUnitPath: target.path }, { deviceIds: [] }],
    [{ orgUnitPath: target.path }, { deviceIds: [id, 'missing-device'] }],
    [
      { orgUnitPath: target.path },
      { deviceIds: Array.from({ length: 51 }, (_, n) => `device-${n}`) },
    ],
  ];
  for (const [query, body] of cases)
    assert.equal(
      (await move(query, body)).status,
      400,
      JSON.stringify([query, body]),
    );
  assert.equal((await get(id)).orgUnitPath, active[0].org_unit_path);
});

test('a hidden device never changes through a write', async (t) => {
  const { harness, domain, api, active, target, get } = await setup(t);
  const [hidden, visible] = active.map((device) => device.device_id);
  const notes = row<{ notes: string | null }>(
    domain.db
      .prepare('SELECT notes FROM devices WHERE device_id = ?')
      .get(hidden),
  )!.notes;
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: hidden,
  });
  assert.equal(
    (await api('PATCH', `${DEVICES}/${hidden}`, { body: { notes: 'x' } }))
      .status,
    404,
  );
  assert.equal(
    (
      await api('POST', `${DEVICES}/moveDevicesToOu`, {
        query: { orgUnitPath: target.path },
        body: { deviceIds: [hidden, visible] },
      })
    ).status,
    400,
  );
  assert.equal(
    row<{ notes: string | null }>(
      domain.db
        .prepare('SELECT notes FROM devices WHERE device_id = ?')
        .get(hidden),
    )!.notes,
    notes,
  );
  assert.equal((await get(visible)).orgUnitPath, active[1].org_unit_path);
});

test('two writes to one device inside one batch both land, and lists show the original until the delay passes', async (t) => {
  const { clock, harness, token, api, active, get } = await setup(t);
  const id = active[0].device_id;
  const path = `/admin/directory/v1${DEVICES}/${id}`;
  const response = await harness.request({
    host: 'www.googleapis.com',
    method: 'POST',
    path: '/batch/admin/directory_v1',
    token,
    headers: { 'content-type': 'multipart/mixed; boundary=batch' },
    body: batchBody([
      { id: 'one', method: 'PATCH', path, body: { notes: 'from part one' } },
      {
        id: 'two',
        method: 'PATCH',
        path,
        body: { annotatedLocation: 'from part two' },
      },
    ]),
  });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(
    [...batchStatuses(response.text)],
    [
      ['one', 200],
      ['two', 200],
    ],
  );
  const got = await get(id);
  assert.equal(got.notes, 'from part one');
  assert.equal(got.annotatedLocation, 'from part two');
  const listed = async () =>
    (
      await api('GET', DEVICES, {
        query: {
          orgUnitPath: active[0].org_unit_path,
          maxResults: 300,
          fields: 'chromeosdevices(deviceId,notes,annotatedLocation)',
        },
      })
    )
      .json()
      .chromeosdevices.find(
        (device: { deviceId: string }) => device.deviceId === id,
      );
  const during = await listed();
  assert.notEqual(during.notes, 'from part one');
  assert.notEqual(during.annotatedLocation, 'from part two');
  await clock.advance(D);
  const after = await listed();
  assert.equal(after.notes, 'from part one');
  assert.equal(after.annotatedLocation, 'from part two');
});

test('a read-only token cannot write, and a deprovisioned device accepts an update', async (t) => {
  const { harness, domain, api } = await setup(t);
  const readOnly = directoryClient(
    harness,
    grantToken(harness, domain, READ_SCOPES),
  );
  const deprovisioned = row<{ device_id: string }>(
    domain.db
      .prepare(
        "SELECT device_id FROM devices WHERE status = 'DEPROVISIONED' LIMIT 1",
      )
      .get(),
  )!.device_id;
  const denied = await readOnly('PATCH', `${DEVICES}/${deprovisioned}`, {
    body: { notes: 'x' },
  });
  assert.equal(denied.status, 403);
  assert.equal(
    denied.json().error.message,
    'Request had insufficient authentication scopes.',
  );
  const accepted = await api('PATCH', `${DEVICES}/${deprovisioned}`, {
    body: { notes: 'Retired' },
  });
  assert.equal(accepted.status, 200, accepted.text);
});

const ACTION = 'CHANGE_CHROME_OS_DEVICE_STATUS_ACTION_';

test('batchChangeStatus disables, re-enables, and deprovisions devices', async (t) => {
  const { api, active, get } = await setup(t);
  const [a, b] = active.map((device) => device.device_id);
  const change = (action: string, ids: string[], extra = {}) =>
    api('POST', `${DEVICES}:batchChangeStatus`, {
      body: {
        deviceIds: ids,
        changeChromeOsDeviceStatusAction: `${ACTION}${action}`,
        ...extra,
      },
    });
  const disabled = await change('DISABLE', [a, b]);
  assert.equal(disabled.status, 200, disabled.text);
  assert.deepEqual(disabled.json(), {
    changeChromeOsDeviceStatusResults: [
      { deviceId: a, response: {} },
      { deviceId: b, response: {} },
    ],
  });
  assert.equal((await get(a)).status, 'DISABLED');
  assert.equal((await change('REENABLE', [a])).status, 200);
  assert.equal((await get(a)).status, 'ACTIVE');
  const retired = await change('DEPROVISION', [a], {
    deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
  });
  assert.equal(retired.status, 200, retired.text);
  const device = await get(a);
  assert.equal(device.status, 'DEPROVISIONED');
  assert.equal(device.deprovisionReason, 'DEPROVISION_REASON_RETIRING_DEVICE');
  assert.ok(device.lastDeprovisionTimestamp);
});

test('batchChangeStatus reports each device error in request order', async (t) => {
  const { api, active } = await setup(t);
  const [a, b] = active.map((device) => device.device_id);
  const response = await api('POST', `${DEVICES}:batchChangeStatus`, {
    body: {
      deviceIds: ['missing-device', a, b],
      changeChromeOsDeviceStatusAction: `${ACTION}REENABLE`,
    },
  });
  assert.equal(response.status, 200, response.text);
  const results = response.json().changeChromeOsDeviceStatusResults;
  assert.deepEqual(
    results.map((result: { deviceId: string }) => result.deviceId),
    ['missing-device', a, b],
  );
  assert.equal(results[0].error.code, 5);
  assert.equal(results[1].error.code, 9);
  assert.equal(results[2].error.code, 9);
});

test('batchChangeStatus rejects a malformed request as a whole', async (t) => {
  const { api, active, get } = await setup(t);
  const id = active[0].device_id;
  for (const body of [
    {
      deviceIds: Array.from({ length: 51 }, () => id),
      changeChromeOsDeviceStatusAction: `${ACTION}DISABLE`,
    },
    { deviceIds: [id] },
    {
      deviceIds: [id],
      changeChromeOsDeviceStatusAction: `${ACTION}UNSPECIFIED`,
    },
    {
      deviceIds: [id],
      changeChromeOsDeviceStatusAction: `${ACTION}DEPROVISION`,
    },
    {
      deviceIds: [id],
      changeChromeOsDeviceStatusAction: `${ACTION}DEPROVISION`,
      deprovisionReason: 'DEPROVISION_REASON_UNSPECIFIED',
    },
  ])
    assert.equal(
      (await api('POST', `${DEVICES}:batchChangeStatus`, { body })).status,
      400,
      JSON.stringify(body),
    );
  assert.equal((await get(id)).status, 'ACTIVE');
});

test('a status change lags in lists', async (t) => {
  const { clock, api, active } = await setup(t);
  const id = active[0].device_id;
  await api('POST', `${DEVICES}:batchChangeStatus`, {
    body: {
      deviceIds: [id],
      changeChromeOsDeviceStatusAction: `${ACTION}DISABLE`,
    },
  });
  const disabled = async () =>
    (
      (
        await api('GET', DEVICES, {
          query: { query: 'status:disabled', maxResults: 300 },
        })
      ).json().chromeosdevices ?? []
    ).some((device: { deviceId: string }) => device.deviceId === id);
  assert.equal(await disabled(), false);
  await clock.advance(D);
  assert.equal(await disabled(), true);
});
