import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { rows } from '../store/sqlite.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const DAY = 86_400_000;
const D = 300_000;
const DEVICES = '/customer/my_customer/devices/chromeos';

async function setup(t: import('node:test').TestContext, scale = 1) {
  const clock = fakeClock();
  const harness = await startHarness({
    clock,
    timing: { scale, delays: false },
  });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  // Tokens last one hour, so every call mints a fresh one after the long advances.
  const api: ReturnType<typeof directoryClient> = (method, path, options) =>
    directoryClient(harness, grantToken(harness, domain, READ_WRITE_SCOPES))(
      method,
      path,
      options,
    );
  const ids = (where: string) =>
    rows<{ device_id: string }>(
      domain.db
        .prepare(`SELECT device_id FROM devices WHERE ${where} ORDER BY ord`)
        .all(clock.now() - DAY),
    ).map((device) => device.device_id);
  const online = ids("status = 'ACTIVE' AND last_sync >= ?");
  const offline = ids("status = 'ACTIVE' AND last_sync < ?");
  const issue = (id: string, body: unknown) =>
    api('POST', `${DEVICES}/${id}:issueCommand`, { body });
  const read = async (id: string, commandId: string) =>
    (await api('GET', `${DEVICES}/${id}/commands/${commandId}`)).json();
  return { clock, harness, domain, api, online, offline, issue, read };
}

test('a command to an online device moves through every state', async (t) => {
  const { clock, online, issue, read } = await setup(t);
  const id = online[0];
  const issued = clock.now();
  const response = await issue(id, { commandType: 'REBOOT' });
  assert.equal(response.status, 200, response.text);
  const { commandId } = response.json();
  assert.match(commandId, /^\d+$/);
  const pending = await read(id, commandId);
  assert.equal(pending.state, 'PENDING');
  assert.equal(pending.type, 'REBOOT');
  assert.equal(pending.issueTime, new Date(issued).toISOString());
  assert.equal(
    pending.commandExpireTime,
    new Date(issued + 5 * DAY).toISOString(),
  );
  await clock.advance(2000);
  assert.equal((await read(id, commandId)).state, 'SENT_TO_CLIENT');
  await clock.advance(3000);
  assert.equal((await read(id, commandId)).state, 'ACKED_BY_CLIENT');
  await clock.advance(55_000);
  const done = await read(id, commandId);
  assert.equal(done.state, 'EXECUTED_BY_CLIENT');
  assert.ok(['SUCCESS', 'FAILURE'].includes(done.commandResult.result));
  const offset = Date.parse(done.commandResult.executeTime) - issued;
  assert.ok(offset >= 10_000 && offset <= 60_000, String(offset));
});

test('a command to an offline device stays pending until it expires', async (t) => {
  const { clock, offline, issue, read } = await setup(t);
  const id = offline[0];
  const { commandId } = (await issue(id, { commandType: 'REBOOT' })).json();
  await clock.advance(DAY);
  assert.equal((await read(id, commandId)).state, 'PENDING');
  await clock.advance(4 * DAY);
  const expired = await read(id, commandId);
  assert.equal(expired.state, 'EXPIRED');
  assert.equal(expired.commandResult, undefined);
});

test('one seed and one command ID always follow the same timeline', async (t) => {
  const first = await setup(t);
  const second = await setup(t);
  const results: unknown[] = [];
  for (const run of [first, second]) {
    const { commandId } = (
      await run.issue(run.online[0], { commandType: 'CAPTURE_LOGS' })
    ).json();
    await run.clock.advance(61_000);
    results.push(await run.read(run.online[0], commandId));
  }
  assert.deepEqual(results[0], results[1]);
});

test('successful reboots refresh the last sync and wipes clear recent users', async (t) => {
  const { clock, domain, api, online, issue, read } = await setup(t);
  const withUsers = new Set(
    rows<{ device_id: string }>(
      domain.db
        .prepare('SELECT device_id FROM devices WHERE recent_users IS NOT NULL')
        .all(),
    ).map((device) => device.device_id),
  );
  const reboots = online.slice(0, 5);
  const wipes = online
    .filter((id) => withUsers.has(id) && !reboots.includes(id))
    .slice(0, 5);
  assert.ok(wipes.length > 0);
  const before = new Map<string, { lastSync: string }>();
  for (const id of [...reboots, ...wipes])
    before.set(id, (await api('GET', `${DEVICES}/${id}`)).json());
  const issued: [string, string, string][] = [];
  for (const id of reboots)
    issued.push([
      id,
      'REBOOT',
      (await issue(id, { commandType: 'REBOOT' })).json().commandId,
    ]);
  for (const id of wipes)
    issued.push([
      id,
      'WIPE_USERS',
      (await issue(id, { commandType: 'WIPE_USERS' })).json().commandId,
    ]);
  await clock.advance(61_000);
  let successes = 0;
  for (const [id, type, commandId] of issued) {
    const command = await read(id, commandId);
    const device = (await api('GET', `${DEVICES}/${id}`)).json();
    const success = command.commandResult.result === 'SUCCESS';
    if (success) successes++;
    if (type === 'REBOOT')
      assert.equal(
        device.lastSync,
        success ? command.commandResult.executeTime : before.get(id)!.lastSync,
      );
    else assert.equal(device.recentUsers === undefined, success);
  }
  assert.ok(successes > 0);
});

test('a side effect lags in lists from its execution time', async (t) => {
  const { clock, domain, api, online, issue, read } = await setup(t);
  const id = online[0];
  const serial = rows<{ serial_number: string }>(
    domain.db
      .prepare('SELECT serial_number FROM devices WHERE device_id = ?')
      .all(id),
  )[0].serial_number;
  const listedSync = async () =>
    (
      await api('GET', DEVICES, {
        query: {
          query: `id:${serial}`,
          fields: 'chromeosdevices(deviceId,lastSync)',
        },
      })
    ).json().chromeosdevices[0].lastSync;
  const before = await listedSync();
  let executed = 0;
  for (let attempt = 0; attempt < 10 && executed === 0; attempt++) {
    const commandId = (await issue(id, { commandType: 'REBOOT' })).json()
      .commandId;
    await clock.advance(61_000);
    const command = await read(id, commandId);
    if (command.commandResult.result === 'SUCCESS')
      executed = Date.parse(command.commandResult.executeTime);
  }
  assert.ok(executed > 0);
  assert.equal(await listedSync(), before);
  await clock.advance(executed + D - clock.now());
  assert.equal(await listedSync(), new Date(executed).toISOString());
});

test('a write settles a due command first, so list states follow each timestamp', async (t) => {
  const { clock, domain, api, online, issue } = await setup(t);
  const id = online[0];
  const stored = (column: string) =>
    (
      domain.db
        .prepare(`SELECT ${column} AS value FROM devices WHERE device_id = ?`)
        .get(id) as { value: string | number | null }
    ).value;
  const serial = String(stored('serial_number'));
  const oldNotes = stored('notes');
  const oldSync = new Date(Number(stored('last_sync'))).toISOString();
  const listed = async () => {
    const entry = (
      await api('GET', DEVICES, {
        query: {
          query: `id:${serial}`,
          fields: 'chromeosdevices(deviceId,lastSync,notes)',
        },
      })
    ).json().chromeosdevices[0];
    return { lastSync: entry.lastSync, notes: entry.notes ?? null };
  };
  // Retry until the REBOOT succeeds. Read the table, not the API, so nothing settles the command.
  let executed = 0;
  for (let attempt = 0; attempt < 10 && executed === 0; attempt++) {
    const { commandId } = (await issue(id, { commandType: 'REBOOT' })).json();
    await clock.advance(61_000);
    const command = domain.db
      .prepare(
        'SELECT executed_at, result FROM device_commands WHERE command_id = ?',
      )
      .get(Number(commandId)) as { executed_at: number; result: string };
    if (command.result === 'SUCCESS') executed = command.executed_at;
  }
  assert.ok(executed > 0);
  const patchTime = clock.now();
  assert.ok(executed < patchTime);
  const patched = await api('PATCH', `${DEVICES}/${id}`, {
    body: { notes: 'Settled first' },
  });
  assert.equal(patched.status, 200, patched.text);
  await clock.advance(executed + D - 1 - clock.now());
  assert.deepEqual(await listed(), { lastSync: oldSync, notes: oldNotes });
  await clock.advance(1);
  assert.deepEqual(await listed(), {
    lastSync: new Date(executed).toISOString(),
    notes: oldNotes,
  });
  await clock.advance(patchTime + D - clock.now());
  assert.deepEqual(await listed(), {
    lastSync: new Date(executed).toISOString(),
    notes: 'Settled first',
  });
});

test('payloads follow the documented rules', async (t) => {
  const { online, issue } = await setup(t);
  const id = online[0];
  const status = async (body: unknown) => (await issue(id, body)).status;
  assert.equal(await status({ commandType: 'SET_VOLUME' }), 400);
  assert.equal(
    await status({ commandType: 'SET_VOLUME', payload: '{"volume":101}' }),
    400,
  );
  assert.equal(
    await status({ commandType: 'SET_VOLUME', payload: '{"volume":"50"}' }),
    400,
  );
  assert.equal(
    await status({ commandType: 'SET_VOLUME', payload: '{"volume":50}' }),
    200,
  );
  assert.equal(
    await status({ commandType: 'REBOOT', payload: '{"volume":50}' }),
    400,
  );
  assert.equal(
    await status({
      commandType: 'DEVICE_START_CRD_SESSION',
      payload: '{"ackedUserPresence":true}',
    }),
    200,
  );
  assert.equal(await status({ commandType: 'COMMAND_TYPE_UNSPECIFIED' }), 400);
  assert.equal(await status({ commandType: 'NOPE' }), 400);
  assert.equal(await status({}), 400);
});

test('documented payloads for reboot, remote sessions, and support packets', async (t) => {
  const { online, issue } = await setup(t);
  const id = online[0];
  const status = async (commandType: string, payload: unknown) =>
    (await issue(id, { commandType, payload: JSON.stringify(payload) })).status;
  assert.equal(
    await status('REBOOT', { user_session_delay_seconds: 120 }),
    200,
  );
  assert.equal(
    await status('REBOOT', { user_session_delay_seconds: 301 }),
    400,
  );
  assert.equal(
    await status('REBOOT', { user_session_delay_seconds: 1.5 }),
    400,
  );
  assert.equal(
    await status('REBOOT', { user_session_delay_seconds: '5' }),
    400,
  );
  assert.equal(
    await status('DEVICE_START_CRD_SESSION', {
      ackedUserPresence: true,
      crdSessionType: 'private',
    }),
    200,
  );
  assert.equal(
    await status('DEVICE_START_CRD_SESSION', { crdSessionType: 'exclusive' }),
    400,
  );
  assert.equal(
    await status('DEVICE_START_CRD_SESSION', { ackedUserPresence: 'yes' }),
    400,
  );
  assert.equal(
    await status('FETCH_SUPPORT_PACKET', {
      supportPacketDetails: {
        issueCaseId: 'case-1',
        issueDescription: 'Slow',
        requestedDataCollectors: [1, 23],
      },
    }),
    200,
  );
  assert.equal(
    await status('FETCH_SUPPORT_PACKET', {
      supportPacketDetails: { requestedDataCollectors: [24] },
    }),
    400,
  );
  assert.equal(
    await status('FETCH_SUPPORT_PACKET', {
      supportPacketDetails: { issueCaseId: 5 },
    }),
    400,
  );
  assert.equal(await status('CAPTURE_LOGS', {}), 400);
});

test('only active devices accept commands, and unknown commands answer 404', async (t) => {
  const { domain, api, online, issue } = await setup(t);
  const disabled = rows<{ device_id: string }>(
    domain.db
      .prepare("SELECT device_id FROM devices WHERE status != 'ACTIVE' LIMIT 1")
      .all(),
  )[0].device_id;
  const refused = await issue(disabled, { commandType: 'REBOOT' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().error.errors[0].reason, 'failedPrecondition');
  const { commandId } = (
    await issue(online[0], { commandType: 'REBOOT' })
  ).json();
  for (const path of [
    `${DEVICES}/${online[0]}/commands/999`,
    `${DEVICES}/${online[0]}/commands/abc`,
    `${DEVICES}/${online[1]}/commands/${commandId}`,
  ])
    assert.equal((await api('GET', path)).status, 404, path);
  assert.equal(
    (await issue('missing-device', { commandType: 'REBOOT' })).status,
    404,
  );
});

test('the time scale shortens the timeline and the expiry is a setting', async (t) => {
  const { clock, harness, domain, online, offline, issue, read } = await setup(
    t,
    60,
  );
  const { commandId } = (
    await issue(online[0], { commandType: 'REBOOT' })
  ).json();
  await clock.advance(Math.ceil(2000 / 60));
  assert.equal((await read(online[0], commandId)).state, 'SENT_TO_CLIENT');
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: { commandExpirySeconds: 600 },
  });
  const late = (await issue(offline[0], { commandType: 'REBOOT' })).json()
    .commandId;
  await clock.advance(10_000);
  assert.equal((await read(offline[0], late)).state, 'EXPIRED');
});
