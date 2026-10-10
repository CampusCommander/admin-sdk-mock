import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { columnsOf, saveBeforeImage } from '../store/lag.ts';
import { row } from '../store/sqlite.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const D = 300_000;

async function setup(t: import('node:test').TestContext, scale = 1) {
  const clock = fakeClock();
  const harness = await startHarness({
    clock,
    timing: { scale, delays: false },
  });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, READ_SCOPES);
  const api = directoryClient(harness, token);
  const db = domain.db;
  const device = row<{ device_id: string; org_unit_path: string }>(
    db
      .prepare(
        "SELECT device_id, org_unit_path FROM devices WHERE status = 'ACTIVE' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!;
  const target = row<{ path: string; org_unit_id: string }>(
    db
      .prepare(
        'SELECT path, org_unit_id FROM orgunits WHERE path != ? AND path != ? ORDER BY ord DESC LIMIT 1',
      )
      .get('/', device.org_unit_path),
  )!;
  /** Move the device the way a write does: a before-image, then the change. */
  const moveDevice = () => {
    saveBeforeImage(db, 'devices', device.device_id, clock.now(), D / scale);
    db.prepare(
      'UPDATE devices SET org_unit_path = ?, org_unit_id = ? WHERE device_id = ?',
    ).run(target.path, target.org_unit_id, device.device_id);
  };
  const listedIn = async (path: string) => {
    const response = await api(
      'GET',
      '/customer/my_customer/devices/chromeos',
      {
        query: { orgUnitPath: path, maxResults: 300 },
      },
    );
    assert.equal(response.status, 200, response.text);
    return (response.json().chromeosdevices ?? []).some(
      (entry: { deviceId: string }) => entry.deviceId === device.device_id,
    );
  };
  return {
    clock,
    harness,
    domain,
    db,
    api,
    device,
    target,
    moveDevice,
    listedIn,
  };
}

test('a moved device stays under its old OU in lists until the delay passes', async (t) => {
  const { clock, api, device, target, moveDevice, listedIn } = await setup(t);
  moveDevice();
  assert.equal(await listedIn(device.org_unit_path), true);
  assert.equal(await listedIn(target.path), false);
  const got = await api(
    'GET',
    `/customer/my_customer/devices/chromeos/${device.device_id}`,
  );
  assert.equal(got.json().orgUnitPath, target.path);
  await clock.advance(D);
  assert.equal(await listedIn(device.org_unit_path), false);
  assert.equal(await listedIn(target.path), true);
});

test('the time scale shortens the delay', async (t) => {
  const { clock, target, moveDevice, listedIn } = await setup(t, 60);
  moveDevice();
  await clock.advance(D / 60 - 1);
  assert.equal(await listedIn(target.path), false);
  await clock.advance(1);
  assert.equal(await listedIn(target.path), true);
});

test('setting the delay to 0 makes lists current at once', async (t) => {
  const { harness, domain, target, moveDevice, listedIn } = await setup(t);
  moveDevice();
  assert.equal(await listedIn(target.path), false);
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: { searchDelaySeconds: 0 },
  });
  assert.equal(await listedIn(target.path), true);
});

test('a new user is missing from users.list until the delay passes, and a get finds it at once', async (t) => {
  const { clock, db, api } = await setup(t);
  const columns = columnsOf(db, 'users');
  const id = '188888888888888888888';
  const email = `lagging.user@${row<{ domain_name: string }>(db.prepare('SELECT domain_name FROM domains WHERE is_primary = 1').get())!.domain_name}`;
  saveBeforeImage(db, 'users', id, clock.now(), D);
  db.prepare(
    `INSERT INTO users (${columns.join(', ')}) SELECT ${columns
      .map((column) =>
        column === 'id'
          ? '?'
          : column === 'primary_email'
            ? '?'
            : column === 'ord'
              ? '(SELECT max(ord) + 1 FROM users)'
              : column,
      )
      .join(', ')} FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 1`,
  ).run(id, email);
  const listed = async () =>
    (
      await api('GET', '/users', {
        query: { customer: 'my_customer', query: `email=${email}` },
      })
    ).json().users?.length ?? 0;
  assert.equal(await listed(), 0);
  assert.equal((await api('GET', `/users/${email}`)).status, 200);
  await clock.advance(D);
  assert.equal(await listed(), 1);
});

test('a new OU is missing from orgunits.list, and lists resolve OU parameters against the lagged view', async (t) => {
  const { clock, db, api } = await setup(t);
  const id = 'id:0lagtestunit01';
  saveBeforeImage(db, 'orgunits', id, clock.now(), D);
  const root = row<{ org_unit_id: string }>(
    db.prepare("SELECT org_unit_id FROM orgunits WHERE path = '/'").get(),
  )!;
  db.prepare(
    "INSERT INTO orgunits (org_unit_id, path, name, description, parent_id, parent_path, depth, kind, ord) VALUES (?, '/Lagging', 'Lagging', '', ?, '/', 1, 'container', 100000)",
  ).run(id, root.org_unit_id);
  const children = async () =>
    (
      (await api('GET', '/customer/my_customer/orgunits')).json()
        .organizationUnits ?? []
    ).map((unit: { orgUnitPath: string }) => unit.orgUnitPath);
  assert.equal((await children()).includes('/Lagging'), false);
  assert.equal(
    (await api('GET', '/customer/my_customer/orgunits/Lagging')).status,
    200,
  );
  const listUnder = await api('GET', '/customer/my_customer/devices/chromeos', {
    query: { orgUnitPath: '/Lagging' },
  });
  assert.equal(listUnder.status, 404);
  await clock.advance(D);
  assert.equal((await children()).includes('/Lagging'), true);
});

test('telemetry lists lag an OU change', async (t) => {
  const { clock, harness, domain, device, target, moveDevice } = await setup(t);
  const token = grantToken(harness, domain, READ_SCOPES);
  moveDevice();
  const listed = async () => {
    const response = await harness.request({
      host: 'chromemanagement.googleapis.com',
      path: '/v1/customers/my_customer/telemetry/devices',
      token,
      query: {
        readMask: 'deviceId,orgUnitId',
        filter: `orgUnitId=${target.org_unit_id.replace(/^id:/, '')}`,
        pageSize: 1000,
      },
    });
    assert.equal(response.status, 200, response.text);
    return (response.json().devices ?? []).some(
      (entry: { deviceId: string }) => entry.deviceId === device.device_id,
    );
  };
  assert.equal(await listed(), false);
  await clock.advance(D);
  assert.equal(await listed(), true);
});

test('a lagging telemetry page plans as a merge of two index scans', async (t) => {
  const { harness, domain, db, moveDevice } = await setup(t);
  const token = grantToken(harness, domain, READ_SCOPES);
  moveDevice();
  const prepare = db.prepare.bind(db);
  const statements: string[] = [];
  db.prepare = (sql: string) => {
    statements.push(sql);
    return prepare(sql);
  };
  const response = await harness.request({
    host: 'chromemanagement.googleapis.com',
    path: '/v1/customers/my_customer/telemetry/devices',
    token,
    query: { readMask: 'deviceId', pageSize: 10 },
  });
  db.prepare = prepare;
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json().devices.length, 10);
  assert.equal(
    Object.keys(response.json().devices[0]).join(),
    'deviceId',
    'the sort column stays out of the output',
  );
  const list = statements.find(
    (sql) => sql.includes('UNION ALL') && sql.includes('devices_prior'),
  );
  assert.ok(list, statements.join('\n'));
  const plan = (
    prepare(`EXPLAIN QUERY PLAN ${list}`).all(
      ...Array((list.match(/\?/g) ?? []).length).fill(10),
    ) as {
      detail: string;
    }[]
  ).map((step) => step.detail);
  assert.ok(
    plan.some((detail) => detail.includes('MERGE')),
    plan.join('\n'),
  );
});

test('default-order paging during writes lists every device exactly once', async (t) => {
  const { clock, harness, domain, db, target } = await setup(t);
  const DEVICES = '/customer/my_customer/devices/chromeos';
  const api: ReturnType<typeof directoryClient> = (method, path, options) =>
    directoryClient(harness, grantToken(harness, domain, READ_WRITE_SCOPES))(
      method,
      path,
      options,
    );
  const total = Number(
    row<{ n: number }>(db.prepare('SELECT count(*) AS n FROM devices').get())!
      .n,
  );
  const everyId = (
    db.prepare('SELECT device_id FROM devices ORDER BY ord').all() as {
      device_id: string;
    }[]
  ).map((entry) => entry.device_id);
  const seen: string[] = [];
  let pageToken: string | undefined;
  let page = 0;
  do {
    const response = await api('GET', DEVICES, {
      query: { maxResults: 7, ...(pageToken ? { pageToken } : {}) },
    });
    assert.equal(response.status, 200, response.text);
    const body = response.json();
    for (const entry of body.chromeosdevices ?? []) seen.push(entry.deviceId);
    pageToken = body.nextPageToken;
    page++;
    // Writes between pages: one or two moves and a notes patch each time.
    const mover = everyId[(page * 11) % everyId.length];
    const noted = everyId[(page * 17 + 3) % everyId.length];
    const move = await api('PATCH', `${DEVICES}/${mover}`, {
      body: { orgUnitPath: page % 2 === 0 ? target.path : '/' },
    });
    assert.equal(move.status, 200, move.text);
    if (page % 3 === 0) {
      const second = await api(
        'PATCH',
        `${DEVICES}/${everyId[(page * 13 + 5) % everyId.length]}`,
        { body: { orgUnitPath: target.path } },
      );
      assert.equal(second.status, 200, second.text);
    }
    const patched = await api('PATCH', `${DEVICES}/${noted}`, {
      body: { notes: `page ${page}` },
    });
    assert.equal(patched.status, 200, patched.text);
    // Some before-images expire mid-enumeration.
    if (page % 4 === 0) await clock.advance(D / 2);
  } while (pageToken);
  assert.ok(page > 5, String(page));
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
  assert.deepEqual(new Set(seen), new Set(everyId));
});

test('a new alias is missing from list bodies and email queries until the delay passes', async (t) => {
  const { clock, db, api } = await setup(t);
  const user = row<{ id: string; primary_email: string }>(
    db
      .prepare(
        'SELECT id, primary_email FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 1',
      )
      .get(),
  )!;
  const alias = `lagging.alias@${user.primary_email.split('@')[1]}`;
  saveBeforeImage(db, 'user_aliases', alias, clock.now(), D);
  db.prepare('INSERT INTO user_aliases (alias, user_id) VALUES (?, ?)').run(
    alias,
    user.id,
  );
  const found = async () =>
    (
      await api('GET', '/users', {
        query: { customer: 'my_customer', query: `email=${alias}` },
      })
    ).json().users ?? [];
  const listedAliases = async (): Promise<string[]> =>
    (
      await api('GET', '/users', {
        query: {
          customer: 'my_customer',
          query: `email=${user.primary_email}`,
        },
      })
    ).json().users?.[0]?.aliases ?? [];
  assert.deepEqual(await found(), []);
  assert.equal((await listedAliases()).includes(alias), false);
  assert.ok(
    (await api('GET', `/users/${alias}`)).json().aliases.includes(alias),
  );
  await clock.advance(D);
  assert.equal((await found()).length, 1);
  assert.equal((await listedAliases()).includes(alias), true);
});
