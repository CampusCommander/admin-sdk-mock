import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { READ_WRITE_SCOPES, startMock } from '@campuscommander/admin-sdk-mock';

let mock;
let undo;
let directory;
let domain;

before(async () => {
  mock = await startMock({
    config: {
      domains: [
        {
          spec: {
            tier: 'small',
            seed: 'example',
            counts: { schools: 1, students: 30, staff: 5, devices: 10 },
          },
        },
      ],
    },
  });
  undo = mock.useInProcess();
  [domain] = mock.domains;
  const key = mock.credential(domain.customerId, 'read-write');
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: READ_WRITE_SCOPES,
    subject: domain.adminEmail,
  });
  directory = admin({ version: 'directory_v1', auth });
});

after(async () => {
  undo?.();
  await mock?.close();
});

test('lists users, Chrome devices, and groups', async () => {
  const users = await directory.users.list({
    customer: 'my_customer',
    maxResults: 10,
  });
  assert.ok(users.data.users.length > 0);
  const devices = await directory.chromeosdevices.list({
    customerId: 'my_customer',
    maxResults: 10,
  });
  assert.ok(devices.data.chromeosdevices.length > 0);
  const groups = await directory.groups.list({
    customer: 'my_customer',
    maxResults: 10,
  });
  assert.ok(groups.data.groups.length > 0);
});

test('inserts a group and reads it back', async () => {
  const email = `example-team@${domain.adminEmail.split('@')[1]}`;
  await directory.groups.insert({
    requestBody: { email, name: 'Example team' },
  });
  const group = await directory.groups.get({ groupKey: email });
  assert.equal(group.data.email, email);
  assert.equal(group.data.name, 'Example team');
});
