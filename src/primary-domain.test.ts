import assert from 'node:assert/strict';
import test from 'node:test';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { READ_SCOPES, startMock, type ServerInfo } from './index.ts';

const OVERRIDE = 'easton-consulting.com';
const SPEC = {
  tier: 'small',
  seed: 'surface',
  name: 'Surface District',
  primaryDomain: OVERRIDE,
  counts: { schools: 1, students: 20, staff: 5, devices: 10 },
};

test('every public surface reports the primaryDomain override', async (t) => {
  const mock = await startMock({ config: { domains: [{ spec: SPEC }] } });
  t.after(() => mock.close());
  const [domain] = mock.domains;

  // The ready event, and GET /info on the control API.
  assert.equal(domain.primaryDomain, OVERRIDE);
  assert.equal(domain.adminEmail, `admin@${OVERRIDE}`);
  const info = (await mock.control('GET', '/info')) as ServerInfo;
  assert.equal(info.domains[0].primaryDomain, OVERRIDE);
  assert.equal(info.domains[0].adminEmail, `admin@${OVERRIDE}`);

  const key = mock.credential(domain.customerId, 'read');
  const restore = mock.useInProcess();
  t.after(restore);
  const directory = admin({
    version: 'directory_v1',
    auth: new JWT({
      email: key.client_email,
      key: key.private_key,
      subject: domain.adminEmail,
      scopes: [...READ_SCOPES],
    }),
  });

  const domains = (await directory.domains.list({ customer: 'my_customer' }))
    .data.domains;
  assert.deepEqual((domains ?? []).map((entry) => entry.domainName).sort(), [
    OVERRIDE,
    `students.${OVERRIDE}`,
  ]);
  const primary = (domains ?? []).find((entry) => entry.isPrimary);
  assert.equal(primary?.domainName, OVERRIDE);
  assert.deepEqual(
    (primary?.domainAliases ?? []).map((alias) => alias.domainAliasName),
    [`k12.${OVERRIDE}`],
  );

  const customer = (
    await directory.customers.get({ customerKey: 'my_customer' })
  ).data;
  assert.equal(customer.customerDomain, OVERRIDE);
  assert.match(customer.alternateEmail ?? '', /\.test$/);

  const users = (await directory.users.list({ customer: 'my_customer' })).data
    .users;
  assert.ok((users ?? []).length > 0);
  assert.ok(
    (users ?? []).some((user) => user.primaryEmail === `admin@${OVERRIDE}`),
  );
  for (const user of users ?? [])
    assert.match(
      user.primaryEmail ?? '',
      new RegExp(`@(${OVERRIDE}|students\\.${OVERRIDE})$`),
    );

  const groups = (await directory.groups.list({ customer: 'my_customer' })).data
    .groups;
  assert.ok((groups ?? []).length > 0);
  for (const group of groups ?? [])
    assert.match(
      group.email ?? '',
      new RegExp(`@(${OVERRIDE}|students\\.${OVERRIDE})$`),
    );
});
