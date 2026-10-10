import { statSync } from 'node:fs';
import { join } from 'node:path';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../../src/auth/scopes.ts';
import { flushLag, pendingLag, saveBeforeImage } from '../../src/store/lag.ts';
import { row, rows } from '../../src/store/sqlite.ts';
import {
  batchBody,
  batchStatuses,
  type BatchRequestPart,
} from '../../src/testing/batch.ts';
import { grantToken, startHarness } from '../../src/testing/harness.ts';

const tier = process.env.SCALE_TIER ?? 'xlarge';
const scale = Number(process.env.SCALE_TIME ?? 600);
const DEVICE_FIELDS =
  'nextPageToken,chromeosdevices(deviceId,serialNumber,model,annotatedAssetId,orgUnitPath,lastSync,annotatedLocation,notes,status)';

const harness = await startHarness({ timing: { scale, delays: true } });
const failures: string[] = [];
try {
  const seedStarted = performance.now();
  const { domain, result } = harness.mock.domains.create(
    { tier, seed: 'scale' },
    Date.now(),
  );
  const seedMs = Math.round(performance.now() - seedStarted);
  if (seedMs > 600_000) failures.push(`Seeding took ${seedMs} ms.`);
  harness.mock.domains.updateSettings(domain.customerId, {
    quota: { perMinute: 1_000_000 },
    chromeQuota: { perMinute: 1_000_000 },
  });
  const token = grantToken(harness, domain, READ_SCOPES);
  const count = (sql: string) =>
    Number(row<{ n: number }>(domain.db.prepare(sql).get())?.n);

  async function enumerate(
    host: string,
    path: string,
    key: string,
    query: Record<string, string | number>,
  ) {
    const started = performance.now();
    let items = 0;
    let pages = 0;
    let pageToken: string | undefined;
    do {
      const response = await harness.request({
        host,
        path,
        token,
        query: { ...query, ...(pageToken ? { pageToken } : {}) },
      });
      if (response.status !== 200)
        throw new Error(
          `${path} answered ${response.status}: ${response.text.slice(0, 200)}`,
        );
      const body = response.json();
      items += body[key]?.length ?? 0;
      pageToken = body.nextPageToken;
      pages++;
    } while (pageToken);
    const ms = Math.round(performance.now() - started);
    return { items, pages, ms, meanPageMs: Math.round(ms / pages) };
  }

  const devices = await enumerate(
    'admin.googleapis.com',
    '/admin/directory/v1/customer/my_customer/devices/chromeos',
    'chromeosdevices',
    { maxResults: 300, fields: DEVICE_FIELDS },
  );
  const users = await enumerate(
    'admin.googleapis.com',
    '/admin/directory/v1/users',
    'users',
    {
      customer: 'my_customer',
      maxResults: 500,
    },
  );
  const orgUnits = await enumerate(
    'admin.googleapis.com',
    '/admin/directory/v1/customer/my_customer/orgunits',
    'organizationUnits',
    { type: 'all' },
  );
  const telemetry = await enumerate(
    'chromemanagement.googleapis.com',
    '/v1/customers/my_customer/telemetry/devices',
    'devices',
    { readMask: 'deviceId,batteryInfo,batteryStatusReport', pageSize: 1000 },
  );

  const expected = {
    devices: count('SELECT count(*) AS n FROM devices'),
    users: count('SELECT count(*) AS n FROM users'),
    orgUnits: count("SELECT count(*) AS n FROM orgunits WHERE path != '/'"),
    telemetry: count(
      "SELECT count(*) AS n FROM devices WHERE status != 'DEPROVISIONED'",
    ),
  };
  const measured = { devices, users, orgUnits, telemetry };
  for (const [name, value] of Object.entries(measured)) {
    if (value.items !== expected[name as keyof typeof expected])
      failures.push(
        `${name}: ${value.items} of ${expected[name as keyof typeof expected]}.`,
      );
    if (value.meanPageMs - 2000 / scale > 250)
      failures.push(
        `${name}: mean server time per page ${value.meanPageMs} ms.`,
      );
  }
  // Groups: page every group, a 1,000-group member sample, all-students derived, and a deep hasMember.
  const groupBound = (name: string, value: { meanPageMs: number }) => {
    if (value.meanPageMs - 2000 / scale > 250)
      failures.push(
        `${name}: mean server time per page ${value.meanPageMs} ms.`,
      );
  };
  const dbMb = Math.round(
    statSync(join(harness.dataDir, 'domains', `${domain.customerId}.sqlite`))
      .size / 1_048_576,
  );
  const groupList = await enumerate(
    'admin.googleapis.com',
    '/admin/directory/v1/groups',
    'groups',
    {
      customer: 'my_customer',
      maxResults: 200,
    },
  );
  const groupTotal = count('SELECT count(*) AS n FROM groups');
  if (groupList.items !== groupTotal)
    failures.push(`groups: ${groupList.items} of ${groupTotal}.`);
  groupBound('groups', groupList);
  const sampleGroups = rows<{ email: string; n: number }>(
    domain.db
      .prepare(
        'SELECT g.email, (SELECT count(*) FROM group_members m WHERE m.group_id = g.id) AS n FROM groups g ORDER BY g.id LIMIT 1000',
      )
      .all(),
  );
  const memberSample = {
    groups: sampleGroups.length,
    items: 0,
    pages: 0,
    ms: 0,
    meanPageMs: 0,
  };
  for (const group of sampleGroups) {
    const result = await enumerate(
      'admin.googleapis.com',
      `/admin/directory/v1/groups/${encodeURIComponent(group.email)}/members`,
      'members',
      { maxResults: 200 },
    );
    if (result.items !== Number(group.n))
      failures.push(
        `members of ${group.email}: ${result.items} of ${group.n}.`,
      );
    memberSample.items += result.items;
    memberSample.pages += result.pages;
    memberSample.ms += result.ms;
  }
  memberSample.meanPageMs = Math.round(
    memberSample.ms / Math.max(1, memberSample.pages),
  );
  groupBound('member sample', memberSample);
  const allStudents = `all-students@${domain.spec.primaryDomain}`;
  const derivedExpected = count(
    `WITH RECURSIVE reach(id) AS (
       SELECT id FROM groups WHERE email = '${allStudents}'
       UNION SELECT m.member_id FROM group_members m JOIN reach r ON m.group_id = r.id WHERE m.type = 'GROUP')
     SELECT count(DISTINCT m.member_id) AS n FROM group_members m WHERE m.group_id IN (SELECT id FROM reach)`,
  );
  const derived = await enumerate(
    'admin.googleapis.com',
    `/admin/directory/v1/groups/${encodeURIComponent(allStudents)}/members`,
    'members',
    { maxResults: 200, includeDerivedMembership: 'true' },
  );
  if (derived.items !== derivedExpected)
    failures.push(
      `derived all-students: ${derived.items} of ${derivedExpected}.`,
    );
  groupBound('derived all-students', derived);
  const chainTop = `committee-1-level-1@${domain.spec.primaryDomain}`;
  const chainUser = row<{ email: string }>(
    domain.db
      .prepare(
        `WITH RECURSIVE walk(id, depth) AS (
           SELECT id, 1 FROM groups WHERE email = ?
           UNION ALL SELECT m.member_id, w.depth + 1 FROM walk w JOIN group_members m ON m.group_id = w.id AND m.type = 'GROUP')
         SELECT m.email FROM group_members m WHERE m.type = 'USER' AND m.group_id = (SELECT id FROM walk ORDER BY depth DESC LIMIT 1) LIMIT 1`,
      )
      .get(chainTop),
  )?.email;
  let deepCheck: { ms: number; isMember: boolean | null } = {
    ms: 0,
    isMember: null,
  };
  if (chainUser) {
    const started = performance.now();
    const response = await harness.request({
      host: 'admin.googleapis.com',
      path: `/admin/directory/v1/groups/${encodeURIComponent(chainTop)}/hasMember/${encodeURIComponent(chainUser)}`,
      token,
    });
    deepCheck = {
      ms: Math.round(performance.now() - started),
      isMember: response.status === 200 ? response.json().isMember : null,
    };
    if (deepCheck.isMember !== true)
      failures.push(
        `deep hasMember answered ${response.status}: ${response.text.slice(0, 200)}`,
      );
  } else failures.push('No deep group chain was seeded.');
  // Lagged derived pages: one waiting membership write outside all-students' reach, then one inside it.
  // A long search delay keeps every before-image waiting while a pass pages, here and in the writes below.
  const delaySeconds = 3_600_000;
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: { searchDelaySeconds: delaySeconds },
  });
  const delayMs = (delaySeconds * 1000) / scale;
  const reachSql = `WITH RECURSIVE reach(id) AS (
       SELECT id FROM groups WHERE email = '${allStudents}'
       UNION SELECT m.member_id FROM group_members m JOIN reach r ON m.group_id = r.id WHERE m.type = 'GROUP')`;
  const outsider = row<{ id: string; email: string }>(
    domain.db
      .prepare(
        `${reachSql} SELECT id, primary_email AS email FROM users WHERE id NOT IN (SELECT member_id FROM group_members WHERE group_id IN (SELECT id FROM reach)) ORDER BY ord LIMIT 1`,
      )
      .get(),
  )!;
  const unrelatedGroup = row<{ id: string }>(
    domain.db
      .prepare(
        `${reachSql} SELECT id FROM groups WHERE id NOT IN (SELECT id FROM reach) AND id NOT IN (SELECT group_id FROM group_members WHERE member_id = ?) ORDER BY id LIMIT 1`,
      )
      .get(outsider.id),
  )!;
  const gradeGroup = row<{ id: string }>(
    domain.db
      .prepare(
        `SELECT g.member_id AS id FROM group_members s JOIN group_members g ON g.group_id = s.member_id AND g.type = 'GROUP'
         WHERE s.group_id = (SELECT id FROM groups WHERE email = ?) AND s.type = 'GROUP' ORDER BY g.id LIMIT 1`,
      )
      .get(allStudents),
  )!;
  /** Add the outsider to a group as members.insert does: an absent marker, then the row. */
  const laggedInsert = (groupId: string) => {
    const id = count('SELECT MAX(id) + 1 AS n FROM group_members');
    saveBeforeImage(domain.db, 'group_members', id, Date.now(), delayMs);
    domain.db
      .prepare(
        "INSERT INTO group_members (id, group_id, member_id, email, type, role, delivery, added_at) VALUES (?, ?, ?, ?, 'USER', 'MEMBER', 'ALL_MAIL', ?)",
      )
      .run(id, groupId, outsider.id, outsider.email, Date.now());
  };
  const pageAllStudents = () =>
    enumerate(
      'admin.googleapis.com',
      `/admin/directory/v1/groups/${encodeURIComponent(allStudents)}/members`,
      'members',
      { maxResults: 200, includeDerivedMembership: 'true' },
    );
  laggedInsert(unrelatedGroup.id);
  const unrelatedLag = await pageAllStudents();
  if (unrelatedLag.items !== derivedExpected)
    failures.push(
      `derived with unrelated lag: ${unrelatedLag.items} of ${derivedExpected}.`,
    );
  groupBound('derived with unrelated lag', unrelatedLag);
  laggedInsert(gradeGroup.id);
  // The new member stays hidden until the delay passes. This pass records its time without a bound.
  const relatedLag = await pageAllStudents();
  if (relatedLag.items !== derivedExpected)
    failures.push(
      `derived with related lag: ${relatedLag.items} of ${derivedExpected}.`,
    );
  const groupLagFlushed = flushLag(domain.db);
  const groups = {
    seeded: {
      groups: result.counts.groups,
      memberships: result.counts.memberships,
    },
    dbMb,
    list: groupList,
    memberSample,
    derived,
    deepCheck,
    unrelatedLag,
    relatedLag,
    groupLagFlushed,
  };
  // Writes: move devices in batches, then page while their before-images wait.
  const writeToken = grantToken(harness, domain, READ_WRITE_SCOPES);
  const moves = Math.min(60_000, expected.devices);
  const target = row<{ path: string }>(
    domain.db
      .prepare(
        "SELECT path FROM orgunits WHERE path != '/' AND path NOT IN (SELECT org_unit_path FROM devices) ORDER BY ord LIMIT 1",
      )
      .get(),
  )!.path;
  const moveIds = rows<{ device_id: string }>(
    domain.db
      .prepare('SELECT device_id FROM devices ORDER BY ord LIMIT ?')
      .all(moves),
  ).map((device) => device.device_id);
  const movePath = `/admin/directory/v1/customer/my_customer/devices/chromeos/moveDevicesToOu?orgUnitPath=${encodeURIComponent(target)}`;
  const parts: BatchRequestPart[] = [];
  for (let start = 0; start < moveIds.length; start += 50)
    parts.push({
      id: `move-${start}`,
      method: 'POST',
      path: movePath,
      body: { deviceIds: moveIds.slice(start, start + 50) },
    });
  const moveStarted = performance.now();
  for (let start = 0; start < parts.length; start += 1000) {
    const slice = parts.slice(start, start + 1000);
    const response = await harness.request({
      host: 'www.googleapis.com',
      method: 'POST',
      path: '/batch/admin/directory_v1',
      token: writeToken,
      headers: { 'content-type': 'multipart/mixed; boundary=batch' },
      body: batchBody(slice),
    });
    const statuses = [...batchStatuses(response.text).values()];
    const failed = statuses.filter((status) => status !== 204).length;
    if (
      response.status !== 200 ||
      statuses.length !== slice.length ||
      failed > 0
    )
      failures.push(
        `Move batch at part ${start}: status ${response.status}, ${statuses.length} parts, ${failed} failed.`,
      );
  }
  const moveMs = Math.round(performance.now() - moveStarted);
  const pending = pendingLag(domain.db, Date.now(), delayMs);
  if (pending < moves)
    failures.push(`Only ${pending} of ${moves} before-images are pending.`);
  const devicePath =
    '/admin/directory/v1/customer/my_customer/devices/chromeos';
  const lagged = await enumerate(
    'admin.googleapis.com',
    devicePath,
    'chromeosdevices',
    {
      maxResults: 300,
      fields: DEVICE_FIELDS,
    },
  );
  if (lagged.items !== expected.devices)
    failures.push(`lagged devices: ${lagged.items} of ${expected.devices}.`);
  if (lagged.meanPageMs - 2000 / scale > 250)
    failures.push(
      `lagged devices: mean server time per page ${lagged.meanPageMs} ms.`,
    );
  const laggedTelemetry = await enumerate(
    'chromemanagement.googleapis.com',
    '/v1/customers/my_customer/telemetry/devices',
    'devices',
    { readMask: 'deviceId', pageSize: 1000 },
  );
  if (laggedTelemetry.items !== expected.telemetry)
    failures.push(
      `lagged telemetry: ${laggedTelemetry.items} of ${expected.telemetry}.`,
    );
  if (laggedTelemetry.meanPageMs - 2000 / scale > 250)
    failures.push(
      `lagged telemetry: mean server time per page ${laggedTelemetry.meanPageMs} ms.`,
    );
  const underTarget = async () =>
    (
      await enumerate('admin.googleapis.com', devicePath, 'chromeosdevices', {
        maxResults: 300,
        orgUnitPath: target,
        fields: 'nextPageToken,chromeosdevices(deviceId)',
      })
    ).items;
  const beforeFlush = await underTarget();
  if (beforeFlush !== 0)
    failures.push(
      `${beforeFlush} moved devices listed before the delay passed.`,
    );
  const flushed = flushLag(domain.db);
  const afterFlush = await underTarget();
  if (afterFlush !== moves)
    failures.push(
      `${afterFlush} of ${moves} moved devices listed after a flush.`,
    );

  // A top-level OU rename cascades to every device and user below it.
  const tops = new Map<string, number>();
  for (const entry of rows<{ org_unit_path: string; n: number }>(
    domain.db
      .prepare(
        'SELECT org_unit_path, count(*) AS n FROM devices GROUP BY org_unit_path',
      )
      .all(),
  )) {
    const top = `/${entry.org_unit_path.split('/')[1] ?? ''}`;
    if (top !== '/') tops.set(top, (tops.get(top) ?? 0) + Number(entry.n));
  }
  const [renamed, renamedDevices] = [...tops].sort((a, b) => b[1] - a[1])[0];
  const renameStarted = performance.now();
  const rename = await harness.request({
    host: 'admin.googleapis.com',
    method: 'PATCH',
    path: `/admin/directory/v1/customer/my_customer/orgunits${renamed.split('/').map(encodeURIComponent).join('/')}`,
    token: writeToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${renamed.slice(1)} Renamed` }),
  });
  const renameMs = Math.round(performance.now() - renameStarted);
  if (rename.status !== 200)
    failures.push(
      `OU rename answered ${rename.status}: ${rename.text.slice(0, 200)}`,
    );
  const writes = {
    moves,
    moveMs,
    pending,
    lagged,
    laggedTelemetry,
    beforeFlush,
    flushed,
    afterFlush,
    rename: { ou: renamed, devices: renamedDevices, ms: renameMs },
  };
  console.log(
    JSON.stringify(
      {
        tier,
        scale,
        seed: { ...result, durationMs: seedMs },
        measured,
        groups,
        writes,
        rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
        failures,
      },
      null,
      2,
    ),
  );
} finally {
  await harness.close();
}
process.exit(failures.length > 0 ? 1 : 0);
