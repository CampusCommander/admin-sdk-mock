import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueServiceAccount } from '../../src/auth/accounts.ts';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../../src/auth/scopes.ts';
import { createMock } from '../../src/mock.ts';
import { row, rows } from '../../src/store/sqlite.ts';
import { startConnectProxy } from './proxy.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'compat-'));
const mock = createMock({ dataDir, timing: { scale: 1, delays: false } });
const google = await mock.listenGoogle(0, '127.0.0.1');
const proxy = await startConnectProxy({
  host: '127.0.0.1',
  port: (google.address() as AddressInfo).port,
});
const { domain } = mock.domains.create(
  {
    tier: 'small',
    seed: 'compat',
    counts: { schools: 3, students: 400, staff: 50, devices: 750 },
  },
  Date.now(),
);
const account = issueServiceAccount(mock.registry, domain.customerId);
mock.registry.setGrant(domain.customerId, account.client_id, READ_SCOPES);
const caFile = join(dataDir, 'ca-export.pem');
const accountFile = join(dataDir, 'account.json');
writeFileSync(caFile, mock.certificates.caCert);
writeFileSync(accountFile, JSON.stringify(account), { mode: 0o600 });

const writes = mock.domains.create(
  {
    tier: 'small',
    seed: 'compat-writes',
    counts: { schools: 2, students: 100, staff: 20, devices: 100 },
  },
  Date.now(),
).domain;
mock.domains.updateSettings(writes.customerId, {
  writes: { orgUnitWritesPerSecond: 1000 },
});
const writeAccount = issueServiceAccount(mock.registry, writes.customerId);
mock.registry.setGrant(
  writes.customerId,
  writeAccount.client_id,
  READ_WRITE_SCOPES,
);
const writeAccountFile = join(dataDir, 'write-account.json');
writeFileSync(writeAccountFile, JSON.stringify(writeAccount), { mode: 0o600 });
const writeExpected = {
  primaryDomain: writes.spec.primaryDomain,
  deviceIds: rows<{ device_id: string }>(
    writes.db
      .prepare(
        "SELECT device_id FROM devices WHERE status = 'ACTIVE' ORDER BY ord LIMIT 3",
      )
      .all(),
  ).map((device) => device.device_id),
  targetOu: row<{ path: string }>(
    writes.db
      .prepare(
        "SELECT path FROM orgunits WHERE path != '/' AND path NOT IN (SELECT org_unit_path FROM devices) ORDER BY ord LIMIT 1",
      )
      .get(),
  )!.path,
};

const groups = mock.domains.create(
  {
    tier: 'small',
    seed: 'compat-groups',
    counts: { schools: 2, students: 150, staff: 20, devices: 20 },
  },
  Date.now(),
).domain;
mock.domains.updateSettings(groups.customerId, {
  writes: { groupReadySeconds: 0 },
});
const groupAccount = issueServiceAccount(mock.registry, groups.customerId);
mock.registry.setGrant(
  groups.customerId,
  groupAccount.client_id,
  READ_WRITE_SCOPES,
);
const groupAccountFile = join(dataDir, 'group-account.json');
writeFileSync(groupAccountFile, JSON.stringify(groupAccount), { mode: 0o600 });
const groupCount = (sql: string, ...params: string[]) =>
  Number(row<{ n: number }>(groups.db.prepare(sql).get(...params))?.n);
const grade = row<{ email: string; member: string }>(
  groups.db
    .prepare(
      "SELECT g.email, m.email AS member FROM groups g JOIN group_members m ON m.group_id = g.id WHERE g.description LIKE 'Students in %' AND m.type = 'USER' ORDER BY g.email, m.email LIMIT 1",
    )
    .get(),
)!;
const groupExpected = {
  primaryDomain: groups.spec.primaryDomain,
  groups: groupCount('SELECT count(*) AS n FROM groups'),
  grade: grade.email,
  gradeMembers: groupCount(
    'SELECT count(*) AS n FROM group_members m JOIN groups g ON g.id = m.group_id WHERE g.email = ?',
    grade.email,
  ),
  student: grade.member,
  studentsGroup: row<{ email: string }>(
    groups.db
      .prepare(
        "SELECT g.email FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.email = ? AND m.type = 'GROUP'",
      )
      .get(grade.email),
  )!.email,
  alias: row<{ alias: string; email: string }>(
    groups.db
      .prepare(
        'SELECT a.alias, g.email FROM group_aliases a JOIN groups g ON g.id = a.group_id ORDER BY a.alias LIMIT 1',
      )
      .get(),
  )!,
  staff: row<{ primary_email: string }>(
    groups.db
      .prepare(
        "SELECT primary_email FROM users WHERE role = 'staff' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!.primary_email,
};

const count = (sql: string) =>
  Number(row<{ n: number }>(domain.db.prepare(sql).get())?.n);
const expected = {
  customerId: domain.customerId,
  primaryDomain: domain.spec.primaryDomain,
  orgUnits: count("SELECT count(*) AS n FROM orgunits WHERE path != '/'"),
  devices: count('SELECT count(*) AS n FROM devices'),
  users: count('SELECT count(*) AS n FROM users'),
  telemetry: count(
    "SELECT count(*) AS n FROM devices WHERE status != 'DEPROVISIONED'",
  ),
  deviceId: row<{ device_id: string }>(
    domain.db.prepare('SELECT device_id FROM devices LIMIT 1').get(),
  )!.device_id,
  telemetryDeviceId: row<{ device_id: string }>(
    domain.db
      .prepare("SELECT device_id FROM devices WHERE status = 'ACTIVE' LIMIT 1")
      .get(),
  )!.device_id,
};

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_EXTRA_CA_CERTS: caFile,
  HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
  MOCK_SA_FILE: accountFile,
  MOCK_SUBJECT: `admin@${domain.spec.primaryDomain}`,
  MOCK_EXPECT: JSON.stringify(expected),
  MOCK_WRITE_SA_FILE: writeAccountFile,
  MOCK_WRITE_SUBJECT: `admin@${writes.spec.primaryDomain}`,
  MOCK_WRITE_EXPECT: JSON.stringify(writeExpected),
  MOCK_GROUP_SA_FILE: groupAccountFile,
  MOCK_GROUP_SUBJECT: `admin@${groups.spec.primaryDomain}`,
  MOCK_GROUP_EXPECT: JSON.stringify(groupExpected),
};
delete env.NO_PROXY;
delete env.no_proxy;
delete env.https_proxy;

const child = spawn(
  process.execPath,
  [
    '--test',
    'test/compat/directory.compat.ts',
    'test/compat/chrome.compat.ts',
    'test/compat/writes.compat.ts',
    'test/compat/groups.compat.ts',
  ],
  { stdio: 'inherit', env },
);
const [code] = (await once(child, 'exit')) as [number | null];
await proxy.close();
console.log(
  `proxy accepted ${proxy.accepted.length} CONNECT(s) (${[...new Set(proxy.accepted)].join(', ')}), refused ${proxy.refused.length}`,
);
const proxied = proxy.accepted.length > 0 && proxy.refused.length === 0;
if (!proxied) console.error('compat traffic did not stay on the proxy');
mock.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(code === 0 && proxied ? 0 : 1);
