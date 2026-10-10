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

const D = 300_000;
const OUS = '/customer/my_customer/orgunits';
const DEVICES = '/customer/my_customer/devices/chromeos';

/** The URL path of one OU. Each path segment is percent-encoded. */
const ou = (path: string) =>
  `${OUS}${path.split('/').map(encodeURIComponent).join('/')}`;

async function setup(t: import('node:test').TestContext) {
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
  const children = async (path: string) =>
    (
      (
        await api('GET', OUS, {
          query: { orgUnitPath: path, type: 'children' },
        })
      ).json().organizationUnits ?? []
    ).map((unit: { orgUnitPath: string }) => unit.orgUnitPath);
  const insert = async (name: string, parentOrgUnitPath: string) => {
    const response = await api('POST', OUS, {
      body: { name, parentOrgUnitPath },
    });
    assert.equal(response.status, 200, response.text);
    return response.json();
  };
  const device = row<{ device_id: string }>(
    domain.db
      .prepare(
        "SELECT device_id FROM devices WHERE status = 'ACTIVE' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!.device_id;
  const otherDevice = row<{ device_id: string }>(
    domain.db
      .prepare(
        "SELECT device_id FROM devices WHERE status = 'ACTIVE' ORDER BY ord LIMIT 1 OFFSET 1",
      )
      .get(),
  )!.device_id;
  const user = row<{ id: string }>(
    domain.db
      .prepare('SELECT id FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 1')
      .get(),
  )!.id;
  /** /Fixture with children "A B" and "A Bc", and "A B/Carts". */
  const fixture = async () => {
    await insert('Fixture', '/');
    await insert('A B', '/Fixture');
    await insert('A Bc', '/Fixture');
    await insert('Carts', '/Fixture/A B');
  };
  return {
    clock,
    harness,
    domain,
    api,
    children,
    insert,
    device,
    otherDevice,
    user,
    fixture,
  };
}

test('insert creates an OU that get finds at once and lists show after the delay', async (t) => {
  const { clock, api, children } = await setup(t);
  const response = await api('POST', OUS, {
    body: { name: 'Fixture', parentOrgUnitPath: '/', description: 'Test unit' },
  });
  assert.equal(response.status, 200, response.text);
  const unit = response.json();
  assert.equal(unit.orgUnitPath, '/Fixture');
  assert.equal(unit.parentOrgUnitPath, '/');
  assert.equal(unit.description, 'Test unit');
  assert.match(unit.orgUnitId, /^id:0[0-9a-z]{13}$/);
  assert.equal((await api('GET', ou('/Fixture'))).status, 200);
  assert.equal((await children('/')).includes('/Fixture'), false);
  await clock.advance(D);
  assert.equal((await children('/')).includes('/Fixture'), true);
});

test('insert accepts a parent ID and validates its fields', async (t) => {
  const { domain, api, insert } = await setup(t);
  const parent = row<{ org_unit_id: string; path: string }>(
    domain.db
      .prepare(
        "SELECT org_unit_id, path FROM orgunits WHERE path != '/' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!;
  for (const id of [
    parent.org_unit_id,
    parent.org_unit_id.replace(/^id:/, ''),
  ]) {
    const response = await api('POST', OUS, {
      body: { name: `Child ${id.length}`, parentOrgUnitId: id },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json().parentOrgUnitPath, parent.path);
  }
  await insert('Fixture', '/');
  for (const body of [
    { name: 'fixture', parentOrgUnitPath: '/' },
    { name: 'Orphan', parentOrgUnitPath: '/No/Such/Unit' },
    { name: 'Orphan' },
    { name: 'A/B', parentOrgUnitPath: '/' },
    { name: '', parentOrgUnitPath: '/' },
    { parentOrgUnitPath: '/' },
  ])
    assert.equal(
      (await api('POST', OUS, { body })).status,
      400,
      JSON.stringify(body),
    );
});

test('a rename cascades to descendant OUs, users, and devices, and leaves a longer sibling alone', async (t) => {
  const { clock, api, children, device, otherDevice, user, fixture } =
    await setup(t);
  await fixture();
  await api('PATCH', `${DEVICES}/${device}`, {
    body: { orgUnitPath: '/Fixture/A B/Carts' },
  });
  await api('PATCH', `${DEVICES}/${otherDevice}`, {
    body: { orgUnitPath: '/Fixture/A Bc' },
  });
  await api('PATCH', `/users/${user}`, {
    body: { orgUnitPath: '/Fixture/A B' },
  });
  await clock.advance(D);
  const response = await api('PATCH', ou('/Fixture/A B'), {
    body: { name: 'Z' },
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json().orgUnitPath, '/Fixture/Z');
  const carts = (await api('GET', ou('/Fixture/Z/Carts'))).json();
  assert.equal(carts.parentOrgUnitPath, '/Fixture/Z');
  assert.equal(
    (await api('GET', `${DEVICES}/${device}`)).json().orgUnitPath,
    '/Fixture/Z/Carts',
  );
  assert.equal(
    (await api('GET', `/users/${user}`)).json().orgUnitPath,
    '/Fixture/Z',
  );
  assert.equal((await api('GET', ou('/Fixture/A Bc'))).status, 200);
  assert.equal(
    (await api('GET', `${DEVICES}/${otherDevice}`)).json().orgUnitPath,
    '/Fixture/A Bc',
  );
  assert.equal((await api('GET', ou('/Fixture/A B'))).status, 404);
  assert.deepEqual((await children('/Fixture')).sort(), [
    '/Fixture/A B',
    '/Fixture/A Bc',
  ]);
  await clock.advance(D);
  assert.deepEqual((await children('/Fixture')).sort(), [
    '/Fixture/A Bc',
    '/Fixture/Z',
  ]);
});

test('a move under a new parent rewrites paths and depths below it', async (t) => {
  const { domain, api, fixture, insert } = await setup(t);
  await fixture();
  await insert('Target', '/');
  const response = await api('PATCH', ou('/Fixture/A B'), {
    body: { parentOrgUnitPath: '/Target' },
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json().orgUnitPath, '/Target/A B');
  assert.equal(response.json().parentOrgUnitPath, '/Target');
  const carts = (await api('GET', ou('/Target/A B/Carts'))).json();
  assert.equal(carts.parentOrgUnitPath, '/Target/A B');
  const depth = (path: string) =>
    row<{ depth: number }>(
      domain.db.prepare('SELECT depth FROM orgunits WHERE path = ?').get(path),
    )!.depth;
  assert.equal(depth('/Target/A B/Carts'), depth('/Target') + 2);
});

test('moves into the own subtree and changes to the root answer 400', async (t) => {
  const { api, fixture } = await setup(t);
  await fixture();
  for (const parentOrgUnitPath of ['/Fixture/A B', '/Fixture'])
    assert.equal(
      (
        await api('PATCH', ou('/Fixture'), {
          body: { parentOrgUnitPath },
        })
      ).status,
      400,
      parentOrgUnitPath,
    );
  const root = `${OUS}/%2F`;
  assert.equal(
    (await api('PATCH', root, { body: { name: 'Renamed' } })).status,
    400,
  );
  assert.equal(
    (await api('PATCH', root, { body: { parentOrgUnitPath: '/Fixture' } }))
      .status,
    400,
  );
  const described = await api('PATCH', root, {
    body: { description: 'District root' },
  });
  assert.equal(described.status, 200, described.text);
  assert.equal(described.json().description, 'District root');
});

test('update behaves like patch', async (t) => {
  const { api, insert } = await setup(t);
  await insert('Fixture', '/');
  const response = await api('PUT', ou('/Fixture'), {
    body: { description: 'Changed' },
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json().name, 'Fixture');
  assert.equal(response.json().description, 'Changed');
});

test('delete removes an empty OU and refuses an OU in use', async (t) => {
  const { clock, api, children, device, user, fixture, insert } =
    await setup(t);
  await fixture();
  await clock.advance(D);
  const removed = await api('DELETE', ou('/Fixture/A Bc'));
  assert.equal(removed.status, 204, removed.text);
  assert.equal((await api('GET', ou('/Fixture/A Bc'))).status, 404);
  assert.equal((await children('/Fixture')).includes('/Fixture/A Bc'), true);
  await clock.advance(D);
  assert.equal((await children('/Fixture')).includes('/Fixture/A Bc'), false);
  await insert('Devices', '/Fixture');
  await insert('People', '/Fixture');
  await api('PATCH', `${DEVICES}/${device}`, {
    body: { orgUnitPath: '/Fixture/Devices' },
  });
  await api('PATCH', `/users/${user}`, {
    body: { orgUnitPath: '/Fixture/People' },
  });
  for (const path of ['/Fixture', '/Fixture/Devices', '/Fixture/People'])
    assert.equal((await api('DELETE', ou(path))).status, 400, path);
  assert.equal((await api('DELETE', `${OUS}/%2F`)).status, 400);
  assert.equal((await api('DELETE', ou('/No/Such/Unit'))).status, 404);
});

test('a rename cascades through a name with a character outside the BMP', async (t) => {
  const { clock, api, device, user, insert } = await setup(t);
  await insert('🏫 Lab', '/');
  await insert('Carts', '/🏫 Lab');
  await api('PATCH', `${DEVICES}/${device}`, {
    body: { orgUnitPath: '/🏫 Lab/Carts' },
  });
  await api('PATCH', `/users/${user}`, { body: { orgUnitPath: '/🏫 Lab' } });
  await clock.advance(D);
  const response = await api('PATCH', ou('/🏫 Lab'), { body: { name: 'Lab' } });
  assert.equal(response.status, 200, response.text);
  const carts = await api('GET', ou('/Lab/Carts'));
  assert.equal(carts.status, 200, carts.text);
  assert.equal(carts.json().parentOrgUnitPath, '/Lab');
  assert.equal(
    (await api('GET', `${DEVICES}/${device}`)).json().orgUnitPath,
    '/Lab/Carts',
  );
  assert.equal((await api('GET', `/users/${user}`)).json().orgUnitPath, '/Lab');
  assert.equal((await api('GET', ou('/🏫 Lab/Carts'))).status, 404);
});

test('a rename onto a sibling name answers 400 and changes nothing', async (t) => {
  const { api, fixture } = await setup(t);
  await fixture();
  const response = await api('PATCH', ou('/Fixture/A B'), {
    body: { name: 'a bc' },
  });
  assert.equal(response.status, 400);
  assert.equal((await api('GET', ou('/Fixture/A B'))).status, 200);
  assert.equal((await api('GET', ou('/Fixture/A B/Carts'))).status, 200);
});

test('insert with an unknown parent ID answers 400', async (t) => {
  const { api } = await setup(t);
  const response = await api('POST', OUS, {
    body: { name: 'Orphan', parentOrgUnitId: 'id:0nosuchunit00' },
  });
  assert.equal(response.status, 400);
});
