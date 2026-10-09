import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { READ_SCOPES } from '../../src/auth/scopes.ts';
import { row } from '../../src/store/sqlite.ts';
import {
  grantToken,
  seedTestDomain,
  startHarness,
} from '../../src/testing/harness.ts';
import { methodSchema, validate, type Discovery } from './validate.ts';

const load = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./discovery/${name}.json`, import.meta.url), 'utf8'),
  ) as Discovery;
const directory = load('directory_v1');
const chrome = load('chromemanagement_v1');
const MASK =
  'name,customer,orgUnitId,deviceId,serialNumber,batteryInfo,batteryStatusReport,memoryInfo,storageInfo';
const D = '/admin/directory/v1';

test('every milestone 1 response matches its discovery schema', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, {
    tier: 'small',
    seed: 'contract',
    counts: { schools: 3, students: 200, staff: 30, devices: 300 },
  });
  const token = grantToken(harness, domain, READ_SCOPES);
  const deviceId = row<{ device_id: string }>(
    domain.db
      .prepare("SELECT device_id FROM devices WHERE status = 'ACTIVE' LIMIT 1")
      .get(),
  )!.device_id;
  const deprovisioned = row<{ device_id: string }>(
    domain.db
      .prepare(
        "SELECT device_id FROM devices WHERE status = 'DEPROVISIONED' LIMIT 1",
      )
      .get(),
  )?.device_id;
  const ou = row<{ path: string }>(
    domain.db
      .prepare("SELECT path FROM orgunits WHERE path != '/' LIMIT 1")
      .get(),
  )!.path;
  const admin = `admin@${domain.spec.primaryDomain}`;
  const devices = `${D}/customer/my_customer/devices/chromeos`;
  const cases: {
    name: string;
    doc: Discovery;
    method: string[];
    host?: string;
    path: string;
    query?: Record<string, string>;
  }[] = [
    {
      name: 'customers.get',
      doc: directory,
      method: ['customers', 'get'],
      path: `${D}/customers/my_customer`,
    },
    {
      name: 'domains.list',
      doc: directory,
      method: ['domains', 'list'],
      path: `${D}/customer/my_customer/domains`,
    },
    {
      name: 'orgunits.list',
      doc: directory,
      method: ['orgunits', 'list'],
      path: `${D}/customer/my_customer/orgunits`,
      query: { type: 'allIncludingParent' },
    },
    {
      name: 'orgunits.get',
      doc: directory,
      method: ['orgunits', 'get'],
      path: `${D}/customer/my_customer/orgunits/${encodeURIComponent(ou.slice(1))}`,
    },
    {
      name: 'chromeosdevices.list FULL',
      doc: directory,
      method: ['chromeosdevices', 'list'],
      path: devices,
      query: { maxResults: '300' },
    },
    {
      name: 'chromeosdevices.list BASIC',
      doc: directory,
      method: ['chromeosdevices', 'list'],
      path: devices,
      query: { maxResults: '300', projection: 'BASIC' },
    },
    {
      name: 'chromeosdevices.get',
      doc: directory,
      method: ['chromeosdevices', 'get'],
      path: `${devices}/${deviceId}`,
    },
    ...(deprovisioned
      ? [
          {
            name: 'chromeosdevices.get deprovisioned',
            doc: directory,
            method: ['chromeosdevices', 'get'],
            path: `${devices}/${deprovisioned}`,
          },
        ]
      : []),
    {
      name: 'users.list',
      doc: directory,
      method: ['users', 'list'],
      path: `${D}/users`,
      query: { customer: 'my_customer', maxResults: '500' },
    },
    {
      name: 'users.list public',
      doc: directory,
      method: ['users', 'list'],
      path: `${D}/users`,
      query: { customer: 'my_customer', viewType: 'domain_public' },
    },
    {
      name: 'users.get',
      doc: directory,
      method: ['users', 'get'],
      path: `${D}/users/${admin}`,
    },
    {
      name: 'telemetry.devices.list',
      doc: chrome,
      method: ['customers', 'telemetry', 'devices', 'list'],
      host: 'chromemanagement.googleapis.com',
      path: '/v1/customers/my_customer/telemetry/devices',
      query: {
        readMask: MASK,
        filter: 'reports_timestamp>=0',
        pageSize: '1000',
      },
    },
    {
      name: 'telemetry.devices.get',
      doc: chrome,
      method: ['customers', 'telemetry', 'devices', 'get'],
      host: 'chromemanagement.googleapis.com',
      path: `/v1/customers/my_customer/telemetry/devices/${deviceId}`,
      query: { readMask: MASK },
    },
  ];
  for (const testCase of cases) {
    const response = await harness.request({
      host: testCase.host ?? 'admin.googleapis.com',
      path: testCase.path,
      query: testCase.query,
      token,
    });
    assert.equal(
      response.status,
      200,
      `${testCase.name}: ${response.text.slice(0, 300)}`,
    );
    assert.deepEqual(
      validate(
        testCase.doc,
        methodSchema(testCase.doc, testCase.method),
        response.json(),
      ),
      [],
      testCase.name,
    );
  }
});
