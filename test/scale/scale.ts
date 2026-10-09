import { READ_SCOPES } from '../../src/auth/scopes.ts';
import { row } from '../../src/store/sqlite.ts';
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
  console.log(
    JSON.stringify(
      {
        tier,
        scale,
        seed: { ...result, durationMs: seedMs },
        measured,
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
