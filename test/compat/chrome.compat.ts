import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chromemanagement } from '@googleapis/chromemanagement';
import { JWT } from 'google-auth-library';
import { SCOPES } from '../../src/auth/scopes.ts';

const key = JSON.parse(readFileSync(process.env.MOCK_SA_FILE!, 'utf8')) as {
  client_email: string;
  private_key: string;
};
const expected = JSON.parse(process.env.MOCK_EXPECT!) as {
  telemetry: number;
  telemetryDeviceId: string;
};

const management = chromemanagement({
  version: 'v1',
  auth: new JWT({
    email: key.client_email,
    key: key.private_key,
    subject: process.env.MOCK_SUBJECT,
    scopes: [...SCOPES.telemetry],
  }),
});

test('telemetry pages through every reporting device', async () => {
  let count = 0;
  let pageToken: string | undefined;
  do {
    const { data } = await management.customers.telemetry.devices.list({
      parent: 'customers/my_customer',
      readMask: 'deviceId,batteryInfo,batteryStatusReport',
      pageSize: 1000,
      pageToken,
    });
    count += data.devices?.length ?? 0;
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  assert.equal(count, expected.telemetry);
});

test('telemetry devices.get returns one device', async () => {
  const { data } = await management.customers.telemetry.devices.get({
    name: `customers/my_customer/telemetry/devices/${expected.telemetryDeviceId}`,
    readMask: 'deviceId',
  });
  assert.equal(data.deviceId, expected.telemetryDeviceId);
});
