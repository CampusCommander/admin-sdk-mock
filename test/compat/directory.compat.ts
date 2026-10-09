import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { READ_SCOPES, SCOPES } from '../../src/auth/scopes.ts';

const key = JSON.parse(readFileSync(process.env.MOCK_SA_FILE!, 'utf8')) as {
  client_email: string;
  private_key: string;
};
const expected = JSON.parse(process.env.MOCK_EXPECT!) as {
  customerId: string;
  primaryDomain: string;
  orgUnits: number;
  devices: number;
  users: number;
  deviceId: string;
};
const auth = (scopes: readonly string[]) =>
  new JWT({
    email: key.client_email,
    key: key.private_key,
    subject: process.env.MOCK_SUBJECT,
    scopes: [...scopes],
  });
const directory = admin({ version: 'directory_v1', auth: auth(READ_SCOPES) });

test('customers.get and domains.list work through the Google client', async () => {
  assert.equal(
    (await directory.customers.get({ customerKey: 'my_customer' })).data.id,
    expected.customerId,
  );
  const domains =
    (await directory.domains.list({ customer: 'my_customer' })).data.domains ??
    [];
  assert.ok(
    domains.some(
      (domain) =>
        domain.domainName === expected.primaryDomain && domain.isPrimary,
    ),
  );
});

test('orgunits.list returns every OU', async () => {
  const { data } = await directory.orgunits.list({
    customerId: 'my_customer',
    type: 'all',
  });
  assert.equal(data.organizationUnits?.length, expected.orgUnits);
});

test('chromeosdevices.list pages through every device', async () => {
  let count = 0;
  let pageToken: string | undefined;
  do {
    const { data } = await directory.chromeosdevices.list({
      customerId: 'my_customer',
      maxResults: 300,
      pageToken,
    });
    count += data.chromeosdevices?.length ?? 0;
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  assert.equal(count, expected.devices);
  const { data } = await directory.chromeosdevices.get({
    customerId: 'my_customer',
    deviceId: expected.deviceId,
  });
  assert.equal(data.deviceId, expected.deviceId);
});

test('users.list pages through every user', async () => {
  let count = 0;
  let pageToken: string | undefined;
  do {
    const { data } = await directory.users.list({
      customer: 'my_customer',
      maxResults: 500,
      pageToken,
    });
    count += data.users?.length ?? 0;
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  assert.equal(count, expected.users);
  const administrator = await directory.users.get({
    userKey: process.env.MOCK_SUBJECT!,
  });
  assert.equal(administrator.data.isAdmin, true);
});

test('getTokenInfo reports the exact requested scope', async () => {
  const client = auth([SCOPES.orgunit[1]]);
  const { token } = await client.getAccessToken();
  const info = await client.getTokenInfo(token!);
  assert.deepEqual(info.scopes, [SCOPES.orgunit[1]]);
});

test('an ungranted scope fails the token exchange', async () => {
  await assert.rejects(
    auth([
      'https://www.googleapis.com/auth/admin.directory.group.readonly',
    ]).getAccessToken(),
    /unauthorized_client/,
  );
});

test('a batch request answers each part', async () => {
  const devices = `/admin/directory/v1/customer/my_customer/devices/chromeos`;
  const body = [
    `--compat\r\nContent-Type: application/http\r\nContent-ID: <a>\r\n\r\nGET ${devices}/${expected.deviceId}\r\n\r\n`,
    `--compat\r\nContent-Type: application/http\r\nContent-ID: <b>\r\n\r\nGET ${devices}/missing\r\n\r\n`,
    '--compat--\r\n',
  ].join('');
  const response = await auth(READ_SCOPES).request<string>({
    url: 'https://www.googleapis.com/batch/admin/directory_v1',
    method: 'POST',
    headers: { 'content-type': 'multipart/mixed; boundary=compat' },
    data: body,
    responseType: 'text',
  });
  assert.match(response.data, /Content-ID: <response-a>\r\n\r\nHTTP\/1\.1 200/);
  assert.match(response.data, /Content-ID: <response-b>\r\n\r\nHTTP\/1\.1 404/);
});
