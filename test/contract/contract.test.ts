import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../../src/auth/scopes.ts';
import { row, rows } from '../../src/store/sqlite.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
  type HarnessResponse,
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

test('every milestone 2 response matches its discovery schema', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, {
    tier: 'small',
    seed: 'contract-writes',
    counts: { schools: 3, students: 200, staff: 30, devices: 300 },
  });
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: { searchDelaySeconds: 0, orgUnitWritesPerSecond: 1000 },
  });
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const check = (name: string, method: string[], response: HarnessResponse) => {
    assert.equal(
      response.status,
      200,
      `${name}: ${response.text.slice(0, 300)}`,
    );
    assert.deepEqual(
      validate(directory, methodSchema(directory, method), response.json()),
      [],
      name,
    );
  };
  const empty = (name: string, response: HarnessResponse) => {
    assert.equal(response.status, 204, `${name}: ${response.text}`);
    assert.equal(response.text, '', name);
  };
  const devices = '/customer/my_customer/devices/chromeos';
  const ids = rows<{ device_id: string }>(
    domain.db
      .prepare(
        "SELECT device_id FROM devices WHERE status = 'ACTIVE' ORDER BY ord LIMIT 3",
      )
      .all(),
  ).map((device) => device.device_id);
  const home = row<{ org_unit_path: string }>(
    domain.db
      .prepare('SELECT org_unit_path FROM devices WHERE device_id = ?')
      .get(ids[0]),
  )!.org_unit_path;

  check(
    'chromeosdevices.patch',
    ['chromeosdevices', 'patch'],
    await api('PATCH', `${devices}/${ids[0]}`, { body: { notes: 'Contract' } }),
  );
  check(
    'chromeosdevices.update',
    ['chromeosdevices', 'update'],
    await api('PUT', `${devices}/${ids[0]}`, {
      body: { annotatedLocation: 'Lab' },
    }),
  );
  empty(
    'chromeosdevices.moveDevicesToOu',
    await api('POST', `${devices}/moveDevicesToOu`, {
      query: { orgUnitPath: home },
      body: { deviceIds: ids },
    }),
  );
  check(
    'chromeos.batchChangeStatus',
    ['customer', 'devices', 'chromeos', 'batchChangeStatus'],
    await api('POST', `${devices}:batchChangeStatus`, {
      body: {
        deviceIds: [ids[2], 'missing-device'],
        changeChromeOsDeviceStatusAction:
          'CHANGE_CHROME_OS_DEVICE_STATUS_ACTION_DISABLE',
      },
    }),
  );
  const issued = await api('POST', `${devices}/${ids[0]}:issueCommand`, {
    body: { commandType: 'SET_VOLUME', payload: '{"volume":40}' },
  });
  check(
    'chromeos.issueCommand',
    ['customer', 'devices', 'chromeos', 'issueCommand'],
    issued,
  );
  check(
    'chromeos.commands.get',
    ['customer', 'devices', 'chromeos', 'commands', 'get'],
    await api(
      'GET',
      `${devices}/${ids[0]}/commands/${issued.json().commandId}`,
    ),
  );

  const email = `contract.user@${domain.spec.primaryDomain}`;
  const inserted = await api('POST', '/users', {
    body: {
      primaryEmail: email,
      name: { givenName: 'Contract', familyName: 'User' },
      password: 'correct horse battery',
      externalIds: [{ value: 'C-1', type: 'organization' }],
    },
  });
  check('users.insert', ['users', 'insert'], inserted);
  const userId = inserted.json().id;
  check(
    'users.patch',
    ['users', 'patch'],
    await api('PATCH', `/users/${userId}`, { body: { suspended: true } }),
  );
  check(
    'users.update',
    ['users', 'update'],
    await api('PUT', `/users/${userId}`, {
      body: { primaryEmail: `contract.renamed@${domain.spec.primaryDomain}` },
    }),
  );
  empty(
    'users.makeAdmin',
    await api('POST', `/users/${userId}/makeAdmin`, { body: { status: true } }),
  );
  empty('users.delete', await api('DELETE', `/users/${userId}`));
  check(
    'users.list showDeleted',
    ['users', 'list'],
    await api('GET', '/users', {
      query: { customer: 'my_customer', showDeleted: 'true' },
    }),
  );
  empty(
    'users.undelete',
    await api('POST', `/users/${userId}/undelete`, {
      body: { orgUnitPath: '/' },
    }),
  );

  const ous = '/customer/my_customer/orgunits';
  check(
    'orgunits.insert',
    ['orgunits', 'insert'],
    await api('POST', ous, {
      body: { name: 'Contract Unit', parentOrgUnitPath: '/', description: 'x' },
    }),
  );
  check(
    'orgunits.patch',
    ['orgunits', 'patch'],
    await api('PATCH', `${ous}/Contract%20Unit`, {
      body: { description: 'y' },
    }),
  );
  check(
    'orgunits.update',
    ['orgunits', 'update'],
    await api('PUT', `${ous}/Contract%20Unit`, {
      body: { name: 'Contract Renamed' },
    }),
  );
  empty('orgunits.delete', await api('DELETE', `${ous}/Contract%20Renamed`));
});

test('every milestone 3 response matches its discovery schema', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, {
    tier: 'small',
    seed: 'contract-groups',
    counts: { schools: 2, students: 150, staff: 20, devices: 20 },
  });
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: {
      searchDelaySeconds: 0,
      groupReadySeconds: 0,
      nestingDelaySeconds: 0,
    },
  });
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const check = (name: string, method: string[], response: HarnessResponse) => {
    assert.equal(
      response.status,
      200,
      `${name}: ${response.text.slice(0, 300)}`,
    );
    assert.deepEqual(
      validate(directory, methodSchema(directory, method), response.json()),
      [],
      name,
    );
  };
  const empty = (name: string, response: HarnessResponse) => {
    assert.equal(response.status, 204, `${name}: ${response.text}`);
    assert.equal(response.text, '', name);
  };
  const P = domain.spec.primaryDomain;
  const grade = row<{ email: string; member: string }>(
    domain.db
      .prepare(
        "SELECT g.email, m.email AS member FROM groups g JOIN group_members m ON m.group_id = g.id WHERE g.description LIKE 'Students in %' AND m.type = 'USER' LIMIT 1",
      )
      .get(),
  )!;
  const staff = row<{ primary_email: string }>(
    domain.db
      .prepare(
        "SELECT primary_email FROM users WHERE role = 'staff' ORDER BY ord LIMIT 1",
      )
      .get(),
  )!.primary_email;

  check(
    'groups.list',
    ['groups', 'list'],
    await api('GET', '/groups', { query: { customer: 'my_customer' } }),
  );
  check(
    'groups.list userKey',
    ['groups', 'list'],
    await api('GET', '/groups', { query: { userKey: grade.member } }),
  );
  check(
    'groups.get',
    ['groups', 'get'],
    await api('GET', `/groups/${grade.email}`),
  );
  check(
    'members.list',
    ['members', 'list'],
    await api('GET', `/groups/${grade.email}/members`),
  );
  check(
    'members.list derived',
    ['members', 'list'],
    await api('GET', `/groups/all-students@${P}/members`, {
      query: { includeDerivedMembership: 'true' },
    }),
  );
  check(
    'members.get',
    ['members', 'get'],
    await api('GET', `/groups/${grade.email}/members/${grade.member}`),
  );
  check(
    'members.hasMember',
    ['members', 'hasMember'],
    await api('GET', `/groups/${grade.email}/hasMember/${grade.member}`),
  );

  const created = await api('POST', '/groups', {
    body: {
      email: `contract-team@${P}`,
      name: 'Contract Team',
      description: 'x',
    },
  });
  check('groups.insert', ['groups', 'insert'], created);
  const team = created.json().email as string;
  check(
    'groups.patch',
    ['groups', 'patch'],
    await api('PATCH', `/groups/${team}`, { body: { description: 'y' } }),
  );
  check(
    'groups.update',
    ['groups', 'update'],
    await api('PUT', `/groups/${team}`, { body: { name: 'Contract' } }),
  );
  check(
    'groups.aliases.insert',
    ['groups', 'aliases', 'insert'],
    await api('POST', `/groups/${team}/aliases`, {
      body: { alias: `contract-alias@${P}` },
    }),
  );
  check(
    'groups.aliases.list',
    ['groups', 'aliases', 'list'],
    await api('GET', `/groups/${team}/aliases`),
  );
  empty(
    'groups.aliases.delete',
    await api('DELETE', `/groups/${team}/aliases/contract-alias@${P}`),
  );
  check(
    'members.insert',
    ['members', 'insert'],
    await api('POST', `/groups/${team}/members`, {
      body: { email: staff, role: 'MANAGER' },
    }),
  );
  check(
    'members.patch',
    ['members', 'patch'],
    await api('PATCH', `/groups/${team}/members/${staff}`, {
      body: { role: 'OWNER' },
    }),
  );
  check(
    'members.update',
    ['members', 'update'],
    await api('PUT', `/groups/${team}/members/${staff}`, {
      body: { delivery_settings: 'DIGEST' },
    }),
  );
  empty(
    'members.delete',
    await api('DELETE', `/groups/${team}/members/${staff}`),
  );
  empty('groups.delete', await api('DELETE', `/groups/${team}`));
});
