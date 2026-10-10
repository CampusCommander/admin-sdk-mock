import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { READ_SCOPES, startMock } from '@campuscommander/admin-sdk-mock';

const DOMAIN = 'lexington-public-schools.test';

let mock;
let undo;
let directory;

before(async () => {
  mock = await startMock({
    config: {
      domains: [
        {
          spec: { tier: 'empty', seed: 'fixtures-example' },
          fixtures: fileURLToPath(new URL('./fixtures.json', import.meta.url)),
        },
      ],
    },
  });
  undo = mock.useInProcess();
  const [domain] = mock.domains;
  assert.equal(domain.adminEmail.split('@')[1], DOMAIN);
  const key = mock.credential(domain.customerId, 'read');
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: READ_SCOPES,
    subject: domain.adminEmail,
  });
  directory = admin({ version: 'directory_v1', auth });
});

after(async () => {
  undo?.();
  await mock?.close();
});

test('the users match the fixtures file', async () => {
  const { data } = await directory.users.list({
    customer: 'my_customer',
    maxResults: 100,
    orderBy: 'email',
  });
  const fixtures = data.users
    .filter((user) => user.primaryEmail !== `admin@${DOMAIN}`)
    .map((user) => ({
      email: user.primaryEmail,
      isAdmin: user.isAdmin,
      suspended: user.suspended,
      orgUnitPath: user.orgUnitPath,
    }));
  assert.deepEqual(fixtures, [
    {
      email: `ada.admin@${DOMAIN}`,
      isAdmin: true,
      suspended: false,
      orgUnitPath: '/Staff',
    },
    {
      email: `pat.paused@${DOMAIN}`,
      isAdmin: false,
      suspended: true,
      orgUnitPath: '/Students',
    },
    {
      email: `sam.student@${DOMAIN}`,
      isAdmin: false,
      suspended: false,
      orgUnitPath: '/Students',
    },
  ]);
});

test('the devices match the fixtures file', async () => {
  const { data } = await directory.chromeosdevices.list({
    customerId: 'my_customer',
    maxResults: 100,
  });
  const devices = data.chromeosdevices
    .map((device) => ({
      serialNumber: device.serialNumber,
      status: device.status,
      orgUnitPath: device.orgUnitPath,
      annotatedUser: device.annotatedUser,
    }))
    .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber));
  assert.deepEqual(devices, [
    {
      serialNumber: 'FIX-0001',
      status: 'ACTIVE',
      orgUnitPath: '/Students',
      annotatedUser: `sam.student@${DOMAIN}`,
    },
    {
      serialNumber: 'FIX-0002',
      status: 'DISABLED',
      orgUnitPath: '/Staff',
      annotatedUser: undefined,
    },
  ]);
});

test('the group members match the fixtures file', async () => {
  const members = async (groupKey) => {
    const { data } = await directory.members.list({ groupKey });
    return data.members
      .map((member) => `${member.email} ${member.role}`)
      .sort();
  };
  assert.deepEqual(await members(`staff@${DOMAIN}`), [
    `ada.admin@${DOMAIN} OWNER`,
    `sam.student@${DOMAIN} MEMBER`,
  ]);
  assert.deepEqual(await members(`students@${DOMAIN}`), [
    `pat.paused@${DOMAIN} MANAGER`,
    `sam.student@${DOMAIN} MEMBER`,
  ]);
});
