import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import tls from 'node:tls';
import test from 'node:test';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { READ_SCOPES, READ_WRITE_SCOPES, startMock } from './index.ts';
import { resolveSpec } from './seed/spec.ts';

test('the unmodified Google client reaches an in-process mock', async (t) => {
  const mock = await startMock({
    config: {
      domains: [
        {
          spec: {
            tier: 'small',
            seed: 'api',
            counts: { schools: 1, students: 20, staff: 5, devices: 10 },
          },
        },
      ],
    },
  });
  t.after(() => mock.close());
  const [domain] = mock.domains;
  const key = mock.credential(domain.customerId, 'read-write');
  const restore = mock.useInProcess();
  t.after(restore);
  const directory = admin({
    version: 'directory_v1',
    auth: new JWT({
      email: key.client_email,
      key: key.private_key,
      subject: domain.adminEmail,
      scopes: [...READ_WRITE_SCOPES],
    }),
  });
  const users = await directory.users.list({
    customer: 'my_customer',
    maxResults: 5,
  });
  assert.equal(users.data.users?.length, 5);
  const groups = await directory.groups.list({
    customer: 'my_customer',
    maxResults: 5,
  });
  assert.ok((groups.data.groups?.length ?? 0) > 0);
});

test('useInProcess restores the CA set and HTTPS_PROXY, in any close order', async () => {
  const baseline = {
    ca: tls.getCACertificates('default').length,
    proxy: process.env.HTTPS_PROXY,
  };
  const a = await startMock();
  const b = await startMock();
  a.useInProcess();
  b.useInProcess();
  const defaults = tls.getCACertificates('default');
  assert.ok(defaults.includes(a.caCert) && defaults.includes(b.caCert));
  assert.equal(process.env.HTTPS_PROXY, b.proxyUrl);
  await a.close();
  assert.ok(!tls.getCACertificates('default').includes(a.caCert));
  assert.ok(tls.getCACertificates('default').includes(b.caCert));
  assert.equal(process.env.HTTPS_PROXY, b.proxyUrl);
  await b.close();
  assert.equal(tls.getCACertificates('default').length, baseline.ca);
  assert.equal(process.env.HTTPS_PROXY, baseline.proxy);
});

test('createDomain applies inline fixtures, and token, env, flush, and close work', async () => {
  const mock = await startMock();
  const primary = resolveSpec({
    tier: 'empty',
    seed: 'api-fixtures',
  }).primaryDomain;
  const domain = await mock.createDomain(
    { tier: 'empty', seed: 'api-fixtures' },
    {
      fixtures: {
        users: [
          { primaryEmail: `x.y@${primary}`, givenName: 'X', familyName: 'Y' },
        ],
      },
    },
  );
  const key = mock.credential(domain.customerId, 'read');
  const restore = mock.useInProcess();
  try {
    const directory = admin({
      version: 'directory_v1',
      auth: new JWT({
        email: key.client_email,
        key: key.private_key,
        subject: domain.adminEmail,
        scopes: [...READ_SCOPES],
      }),
    });
    const users = await directory.users.list({ customer: 'my_customer' });
    assert.deepEqual(
      users.data.users?.map((user) => user.primaryEmail).sort(),
      [`admin@${primary}`, `x.y@${primary}`],
    );
  } finally {
    restore();
  }
  assert.match(await mock.token(domain.customerId), /^ya29\.mock\./);
  assert.equal(mock.env().HTTPS_PROXY, mock.proxyUrl);
  assert.ok(await mock.flush(domain.customerId));
  const caFile = mock.caFile;
  await mock.close();
  assert.equal(existsSync(caFile), false);
});

test('proxy false starts no proxy, and useInProcess then throws', async () => {
  const mock = await startMock({ proxy: false });
  assert.equal(mock.proxyUrl, null);
  assert.throws(() => mock.useInProcess(), /The proxy is off/);
  await mock.close();
});
