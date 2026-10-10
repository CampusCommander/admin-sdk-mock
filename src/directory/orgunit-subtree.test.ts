import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { row } from '../store/sqlite.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const OUS = '/customer/my_customer/orgunits';
const DEVICES = '/customer/my_customer/devices/chromeos';

test('subtree filters match OUs whose names have non-BMP characters', async (t) => {
  const clock = fakeClock();
  const harness = await startHarness({ clock });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: { orgUnitWritesPerSecond: 1000 },
  });
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  for (const [name, parentOrgUnitPath] of [
    ['🏫 Lab', '/'],
    ['Carts', '/🏫 Lab'],
  ])
    assert.equal(
      (await api('POST', OUS, { body: { name, parentOrgUnitPath } })).status,
      200,
    );
  const device = row<{ device_id: string }>(
    domain.db
      .prepare("SELECT device_id FROM devices WHERE status = 'ACTIVE' LIMIT 1")
      .get(),
  )!.device_id;
  const user = row<{ id: string }>(
    domain.db.prepare('SELECT id FROM users WHERE is_admin = 0 LIMIT 1').get(),
  )!.id;
  await api('PATCH', `${DEVICES}/${device}`, {
    body: { orgUnitPath: '/🏫 Lab/Carts' },
  });
  await api('PATCH', `/users/${user}`, {
    body: { orgUnitPath: '/🏫 Lab/Carts' },
  });
  await clock.advance(300_000);
  const devices = await api('GET', DEVICES, {
    query: { orgUnitPath: '/🏫 Lab', includeChildOrgunits: 'true' },
  });
  assert.equal(devices.status, 200, devices.text);
  assert.deepEqual(
    devices.json().chromeosdevices.map((d: { deviceId: string }) => d.deviceId),
    [device],
  );
  const users = await api('GET', '/users', {
    query: { query: "orgUnitPath='/🏫 Lab'", customer: 'my_customer' },
  });
  assert.equal(users.status, 200, users.text);
  assert.deepEqual(
    users.json().users.map((u: { id: string }) => u.id),
    [user],
  );
  const all = await api('GET', OUS, {
    query: { orgUnitPath: '/🏫 Lab', type: 'all' },
  });
  assert.deepEqual(
    all
      .json()
      .organizationUnits.map((u: { orgUnitPath: string }) => u.orgUnitPath),
    ['/🏫 Lab/Carts'],
  );
});
