import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { join } from 'node:path';
import tls from 'node:tls';
import test from 'node:test';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import {
  ConfigError,
  FixtureError,
  READ_SCOPES,
  READ_WRITE_SCOPES,
  startMock,
} from './index.ts';
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

test('createDomain applies defaults.settings, then its own settings', async (t) => {
  const mock = await startMock({
    config: {
      defaults: {
        settings: { quota: { perMinute: 77 }, latency: { capMs: 900 } },
      },
    },
  });
  t.after(() => mock.close());
  const domain = await mock.createDomain(
    { tier: 'empty', seed: 'api-defaults' },
    { settings: { quota: { perMinute: 55 } } },
  );
  const record = (await mock.control(
    'GET',
    `/domains/${domain.customerId}`,
  )) as {
    settings: { quota: { perMinute: number }; latency: { capMs: number } };
  };
  assert.equal(record.settings.quota.perMinute, 55);
  assert.equal(record.settings.latency.capMs, 900);
});

test('useInProcess sets NO_PROXY to the loopback list, so an ambient NO_PROXY cannot bypass the mock', async (t) => {
  const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
  t.after(() => {
    for (const [name, value] of [
      ['NO_PROXY', saved.upper],
      ['no_proxy', saved.lower],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env.NO_PROXY = '.googleapis.com';
  process.env.no_proxy = 'googleapis.com';
  const mock = await startMock({
    config: { domains: [{ spec: { tier: 'empty', seed: 'api-no-proxy' } }] },
  });
  t.after(() => mock.close());
  const [domain] = mock.domains;
  const key = mock.credential(domain.customerId, 'read');
  const restore = mock.useInProcess();
  try {
    assert.equal(process.env.NO_PROXY, 'localhost,127.0.0.1,::1');
    assert.equal(process.env.no_proxy, 'localhost,127.0.0.1,::1');
    const auth = new JWT({
      email: key.client_email,
      key: key.private_key,
      subject: domain.adminEmail,
      scopes: [...READ_SCOPES],
    });
    assert.match((await auth.getAccessToken()).token ?? '', /^ya29\.mock\./);
  } finally {
    restore();
  }
  assert.equal(process.env.NO_PROXY, '.googleapis.com');
  assert.equal(process.env.no_proxy, 'googleapis.com');
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  mock.useInProcess()();
  assert.equal(process.env.NO_PROXY, undefined);
  assert.equal(process.env.no_proxy, undefined);
});

/** Ask the mock's tokeninfo route how many seconds a token has left. */
function secondsLeft(googleUrl: string, ca: string, token: string) {
  const { hostname, port } = new URL(googleUrl);
  return new Promise<number>((resolve, reject) => {
    https
      .get(
        {
          host: hostname,
          port,
          path: `/tokeninfo?access_token=${token}`,
          headers: { host: 'oauth2.googleapis.com' },
          servername: 'oauth2.googleapis.com',
          ca,
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () =>
            resolve(
              Number((JSON.parse(text) as { expires_in: string }).expires_in),
            ),
          );
        },
      )
      .on('error', reject);
  });
}

test('the package exports ConfigError and FixtureError, and token() takes ttlSeconds', async (t) => {
  await assert.rejects(
    startMock({ config: { listen: { proxy: false } } }),
    ConfigError,
  );
  const mock = await startMock();
  t.after(() => mock.close());
  await assert.rejects(
    mock.createDomain(
      { tier: 'empty', seed: 'api-errors' },
      { fixtures: { users: 5 } },
    ),
    FixtureError,
  );
  const domain = await mock.createDomain({ tier: 'empty', seed: 'api-ttl' });
  const token = await mock.token(domain.customerId, { ttlSeconds: 60 });
  const left = await secondsLeft(mock.googleUrl, mock.caCert, token);
  assert.ok(left > 50 && left <= 60, String(left));
  await assert.rejects(
    mock.token(domain.customerId, { ttlSeconds: 0 }),
    /ttlSeconds must be a whole number from 1 to 3600/,
  );
});
