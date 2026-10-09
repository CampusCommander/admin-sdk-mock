import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueServiceAccount } from '../../src/auth/accounts.ts';
import { READ_SCOPES } from '../../src/auth/scopes.ts';
import { createMock } from '../../src/mock.ts';
import { row } from '../../src/store/sqlite.ts';
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
};

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_EXTRA_CA_CERTS: caFile,
  HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
  MOCK_SA_FILE: accountFile,
  MOCK_SUBJECT: `admin@${domain.spec.primaryDomain}`,
  MOCK_EXPECT: JSON.stringify(expected),
};
delete env.NO_PROXY;
delete env.no_proxy;
delete env.https_proxy;

const child = spawn(
  process.execPath,
  ['--test', 'test/compat/directory.compat.ts', 'test/compat/chrome.compat.ts'],
  { stdio: 'inherit', env },
);
const [code] = (await once(child, 'exit')) as [number | null];
await proxy.close();
mock.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(code ?? 1);
