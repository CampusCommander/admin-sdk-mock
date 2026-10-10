import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('useInProcess restores the CA set and HTTPS_PROXY, in any close order', async (t) => {
  const baseline = {
    ca: tls.getCACertificates('default').length,
    proxy: process.env.HTTPS_PROXY,
  };
  const a = await startMock();
  t.after(() => a.close());
  const b = await startMock();
  t.after(() => b.close());
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

test('createDomain applies inline fixtures, and token, env, flush, and close work', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
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

test('proxy false starts no proxy, and useInProcess then throws', async (t) => {
  const mock = await startMock({ proxy: false });
  t.after(() => mock.close());
  assert.equal(mock.proxyUrl, null);
  assert.throws(() => mock.useInProcess(), /The proxy is off/);
  await mock.close();
});

test('createDomain shows in GET /info, and a repeat call adds no duplicate', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const spec = { tier: 'empty', seed: 'api-info' };
  const first = await mock.createDomain(spec);
  const second = await mock.createDomain(spec);
  assert.deepEqual(Object.keys(second), Object.keys(first));
  assert.equal(second.customerId, first.customerId);
  const info = (await mock.control('GET', '/info')) as {
    domains: { customerId: string }[];
  };
  assert.deepEqual(
    info.domains.map((d) => d.customerId),
    [first.customerId],
  );
  assert.equal(mock.domains.length, 1);
});

test('an earlier restore undoes only its own install', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const first = mock.useInProcess();
  const second = mock.useInProcess();
  first();
  assert.ok(tls.getCACertificates('default').includes(mock.caCert));
  assert.equal(process.env.HTTPS_PROXY, mock.proxyUrl);
  second();
  assert.ok(!tls.getCACertificates('default').includes(mock.caCert));
});

test('useInProcess throws after close', async () => {
  const mock = await startMock();
  await mock.close();
  assert.throws(() => mock.useInProcess(), /The mock is closed\./);
});

test('listener options merge per listener', async (t) => {
  const google = await startMock({
    config: { listen: { google: { host: '127.0.0.1' } } },
  });
  t.after(() => google.close());
  assert.notEqual(new URL(google.googleUrl).port, '8443');
  const proxy = await startMock({
    config: { listen: { proxy: { port: 0 } } },
  });
  t.after(() => proxy.close());
  const info = (await proxy.control('GET', '/info')) as {
    listeners: { proxy: { passthrough: boolean } | null };
  };
  assert.equal(info.listeners.proxy?.passthrough, true);
  const off = await startMock({ config: { listen: { proxy: null } } });
  t.after(() => off.close());
  assert.equal(off.proxyUrl, null);
});

test('a caller-supplied data directory survives close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-test-'));
  try {
    const mock = await startMock({ config: { dataDir: dir } });
    assert.ok(existsSync(join(dir, 'ca', 'ca.pem')));
    const info = (await mock.control('GET', '/info')) as { dataDir: string };
    assert.equal(info.dataDir, dir);
    await mock.close();
    assert.ok(existsSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listen.proxy false is rejected as a configuration error', async () => {
  await assert.rejects(
    startMock({ config: { listen: { proxy: false } } }),
    (error: Error) => error.name === 'ConfigError',
  );
});

test('a repeat createDomain keeps the configured service account', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'api-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'key.json');
  const spec = { tier: 'empty', seed: 'api-keep' };
  const mock = await startMock({
    config: { domains: [{ spec, serviceAccounts: [{ out, scopes: 'read' }] }] },
  });
  t.after(() => mock.close());
  assert.equal(mock.env().GOOGLE_APPLICATION_CREDENTIALS, out);
  await mock.createDomain(spec);
  assert.equal(mock.env().GOOGLE_APPLICATION_CREDENTIALS, out);
  assert.equal(mock.domains.length, 1);
});
