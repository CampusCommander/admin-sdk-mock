import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { READ_WRITE_SCOPES } from '../../src/auth/scopes.ts';
import { batchBody, batchStatuses } from '../../src/testing/batch.ts';

const key = JSON.parse(
  readFileSync(process.env.MOCK_WRITE_SA_FILE!, 'utf8'),
) as { client_email: string; private_key: string };
const expected = JSON.parse(process.env.MOCK_WRITE_EXPECT!) as {
  primaryDomain: string;
  deviceIds: string[];
  targetOu: string;
};
const auth = new JWT({
  email: key.client_email,
  key: key.private_key,
  subject: process.env.MOCK_WRITE_SUBJECT,
  scopes: [...READ_WRITE_SCOPES],
});
const directory = admin({ version: 'directory_v1', auth });
const customerId = 'my_customer';
const notFound = (error: { response?: { status?: number } }) =>
  error.response?.status === 404;

test('device patch, update, and moveDevicesToOu work through the Google client', async () => {
  const [first, second] = expected.deviceIds;
  const patched = await directory.chromeosdevices.patch({
    customerId,
    deviceId: first,
    requestBody: { notes: 'Compat patch' },
  });
  assert.equal(patched.data.notes, 'Compat patch');
  const updated = await directory.chromeosdevices.update({
    customerId,
    deviceId: first,
    requestBody: { annotatedLocation: 'Compat lab' },
  });
  assert.equal(updated.data.annotatedLocation, 'Compat lab');
  assert.equal(updated.data.notes, 'Compat patch');
  const moved = await directory.chromeosdevices.moveDevicesToOu({
    customerId,
    orgUnitPath: expected.targetOu,
    requestBody: { deviceIds: [first, second] },
  });
  assert.equal(moved.status, 204);
  const got = await directory.chromeosdevices.get({
    customerId,
    deviceId: second,
  });
  assert.equal(got.data.orgUnitPath, expected.targetOu);
});

test('batchChangeStatus, issueCommand, and commands.get work through the Google client', async () => {
  const third = expected.deviceIds[2];
  const chromeos = directory.customer.devices.chromeos;
  const disabled = await chromeos.batchChangeStatus({
    customerId,
    requestBody: {
      deviceIds: [third],
      changeChromeOsDeviceStatusAction:
        'CHANGE_CHROME_OS_DEVICE_STATUS_ACTION_DISABLE',
    },
  });
  assert.deepEqual(disabled.data.changeChromeOsDeviceStatusResults, [
    { deviceId: third, response: {} },
  ]);
  await chromeos.batchChangeStatus({
    customerId,
    requestBody: {
      deviceIds: [third],
      changeChromeOsDeviceStatusAction:
        'CHANGE_CHROME_OS_DEVICE_STATUS_ACTION_REENABLE',
    },
  });
  const issued = await chromeos.issueCommand({
    customerId,
    deviceId: third,
    requestBody: { commandType: 'REBOOT' },
  });
  assert.match(issued.data.commandId ?? '', /^\d+$/);
  const command = await chromeos.commands.get({
    customerId,
    deviceId: third,
    commandId: issued.data.commandId!,
  });
  assert.equal(command.data.type, 'REBOOT');
  assert.ok(['PENDING', 'SENT_TO_CLIENT'].includes(command.data.state ?? ''));
});

test('user insert, patch, update, makeAdmin, delete, and undelete work through the Google client', async () => {
  const email = `compat.writer@${expected.primaryDomain}`;
  const inserted = await directory.users.insert({
    requestBody: {
      primaryEmail: email,
      name: { givenName: 'Compat', familyName: 'Writer' },
      password: 'correct horse battery',
    },
  });
  const id = inserted.data.id!;
  assert.equal(inserted.data.primaryEmail, email);
  const patched = await directory.users.patch({
    userKey: id,
    requestBody: { suspended: true },
  });
  assert.equal(patched.data.suspended, true);
  const updated = await directory.users.update({
    userKey: id,
    requestBody: { name: { givenName: 'Renamed' } },
  });
  assert.equal(updated.data.name?.fullName, 'Renamed Writer');
  await directory.users.makeAdmin({
    userKey: id,
    requestBody: { status: true },
  });
  assert.equal((await directory.users.get({ userKey: id })).data.isAdmin, true);
  await directory.users.delete({ userKey: id });
  await assert.rejects(directory.users.get({ userKey: id }), notFound);
  await directory.users.undelete({
    userKey: id,
    requestBody: { orgUnitPath: '/' },
  });
  assert.equal(
    (await directory.users.get({ userKey: id })).data.primaryEmail,
    email,
  );
});

test('OU insert, patch, update, and delete work through the Google client', async () => {
  const inserted = await directory.orgunits.insert({
    customerId,
    requestBody: { name: 'Compat Unit', parentOrgUnitPath: '/' },
  });
  assert.equal(inserted.data.orgUnitPath, '/Compat Unit');
  const patched = await directory.orgunits.patch({
    customerId,
    orgUnitPath: 'Compat Unit',
    requestBody: { description: 'Patched' },
  });
  assert.equal(patched.data.description, 'Patched');
  const updated = await directory.orgunits.update({
    customerId,
    orgUnitPath: 'Compat Unit',
    requestBody: { name: 'Compat Renamed' },
  });
  assert.equal(updated.data.orgUnitPath, '/Compat Renamed');
  const removed = await directory.orgunits.delete({
    customerId,
    orgUnitPath: 'Compat Renamed',
  });
  assert.equal(removed.status, 204);
  await assert.rejects(
    directory.orgunits.get({ customerId, orgUnitPath: 'Compat Renamed' }),
    notFound,
  );
});

test('write parts inside a batch answer one by one', async () => {
  const devices = '/admin/directory/v1/customer/my_customer/devices/chromeos';
  const [first] = expected.deviceIds;
  const insertUser = async (name: string) =>
    (
      await directory.users.insert({
        requestBody: {
          primaryEmail: `${name}@${expected.primaryDomain}`,
          name: { givenName: name, familyName: 'Batch' },
          password: 'correct horse battery',
        },
      })
    ).data.id!;
  const patchedUser = await insertUser('batch.patched');
  const deletedUser = await insertUser('batch.deleted');
  await directory.orgunits.insert({
    customerId,
    requestBody: { name: 'Batch Unit', parentOrgUnitPath: '/' },
  });
  const users = '/admin/directory/v1/users';
  const response = await auth.request<string>({
    url: 'https://www.googleapis.com/batch/admin/directory_v1',
    method: 'POST',
    headers: { 'content-type': 'multipart/mixed; boundary=compat' },
    data: batchBody(
      [
        {
          id: 'patch',
          method: 'PATCH',
          path: `${devices}/${first}`,
          body: { notes: 'Batch note' },
        },
        {
          id: 'move',
          method: 'POST',
          path: `${devices}/moveDevicesToOu?orgUnitPath=${encodeURIComponent(expected.targetOu)}`,
          body: { deviceIds: [first] },
        },
        {
          id: 'missing',
          method: 'PATCH',
          path: `${devices}/missing-device`,
          body: { notes: 'x' },
        },
        {
          id: 'user-patch',
          method: 'PATCH',
          path: `${users}/${patchedUser}`,
          body: { name: { givenName: 'Batch' } },
        },
        {
          id: 'user-delete',
          method: 'DELETE',
          path: `${users}/${deletedUser}`,
        },
        {
          id: 'ou-patch',
          method: 'PATCH',
          path: `/admin/directory/v1/customer/${customerId}/orgunits/${encodeURIComponent('Batch Unit')}`,
          body: { description: 'Batch' },
        },
      ],
      'compat',
    ),
    responseType: 'text',
  });
  assert.deepEqual(
    [...batchStatuses(response.data)],
    [
      ['patch', 200],
      ['move', 204],
      ['missing', 404],
      ['user-patch', 200],
      ['user-delete', 204],
      ['ou-patch', 200],
    ],
  );
});
