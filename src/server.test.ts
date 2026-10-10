import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import tls from 'node:tls';
import { READ_SCOPES } from './auth/scopes.ts';
import { resolveConfig } from './config/config.ts';
import { FixtureError } from './seed/fixtures.ts';
import { clientEnvironment, startServer, type ServerInfo } from './server.ts';
import { VERSION } from './version.ts';

const EMPTY = { tier: 'empty', seed: 'server', name: 'Server District' };
const PRIMARY = 'server-district.test';
const LISTEN = {
  google: { port: 0 },
  control: { port: 0 },
  proxy: { port: 0 },
};

type Event = Record<string, unknown>;

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'server-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Resolve a configuration in `dir` with every listener on port 0 and delays off. */
const configIn = (dir: string, file: Record<string, unknown> = {}) =>
  resolveConfig({
    cwd: dir,
    file: { listen: LISTEN, timing: { delays: false }, ...file },
  });

async function start(t: TestContext, file: Record<string, unknown> = {}) {
  const dir = tempDir(t);
  const events: Event[] = [];
  const handle = await startServer(configIn(dir, file), {
    log: (event) => events.push(event),
  });
  t.after(() => handle.close());
  return { dir, handle, events };
}

/**
 * Whether a loopback port is free: a new listener can bind it. A refused connection is not
 * proof, because some hosts (WSL mirrored networking) keep accepting on a closed port.
 */
const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

/** CONNECT through the proxy, speak TLS to admin.googleapis.com, and return the status line. */
async function tunnelGet(
  proxyPort: number,
  ca: string,
  path: string,
  token?: string,
): Promise<string> {
  const connect = http.request({
    host: '127.0.0.1',
    port: proxyPort,
    method: 'CONNECT',
    path: 'admin.googleapis.com:443',
    agent: false,
  });
  connect.end();
  const [response, socket] = (await once(connect, 'connect')) as [
    http.IncomingMessage,
    net.Socket,
  ];
  assert.equal(response.statusCode, 200);
  const secure = tls.connect({
    socket,
    servername: 'admin.googleapis.com',
    ca,
  });
  await once(secure, 'secureConnect');
  let text = '';
  secure.setEncoding('utf8');
  secure.on('data', (chunk: string) => (text += chunk));
  secure.write(
    `GET ${path} HTTP/1.1\r\nHost: admin.googleapis.com\r\n${
      token ? `Authorization: Bearer ${token}\r\n` : ''
    }Connection: close\r\n\r\n`,
  );
  await once(secure, 'end');
  return text.split('\r\n')[0];
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('startServer reports the real listeners, the version, the domains, and the CA files', async (t) => {
  const { handle } = await start(t, { domains: [{ spec: EMPTY }] });
  const info = handle.info();
  assert.equal(info.ready, true);
  assert.equal(info.version, VERSION);
  const { google, control, proxy } = info.listeners;
  assert.equal(google.host, '127.0.0.1');
  assert.ok(google.port > 0 && control.port > 0);
  assert.deepEqual(proxy, {
    host: '127.0.0.1',
    port: handle.proxy!.port,
    passthrough: false,
  });
  assert.equal(handle.controlUrl, `http://127.0.0.1:${control.port}`);
  assert.equal(handle.googleUrl, `https://127.0.0.1:${google.port}`);
  assert.equal(info.domains.length, 1);
  assert.equal(info.domains[0].primaryDomain, PRIMARY);
  assert.equal(info.domains[0].action, 'created');
  const ca = handle.mock.certificates.caCert;
  assert.equal(readFileSync(info.caFile, 'utf8'), ca);
  assert.equal(info.caBundleFile, info.caFile.replace(/\.pem$/, '-bundle.pem'));
  const bundle = readFileSync(info.caBundleFile, 'utf8');
  assert.ok(bundle.startsWith(ca.trimEnd()));
  for (const root of tls.rootCertificates) assert.ok(bundle.includes(root));
});

test('startServer logs started, one domain event per domain, then ready, and writes the ready file', async (t) => {
  const { dir, handle, events } = await start(t, {
    readyFile: 'out/ready.json',
    domains: [{ spec: EMPTY }, { spec: { tier: 'empty', seed: 'second' } }],
  });
  assert.deepEqual(
    events.map((event) => event.event),
    ['started', 'domain', 'domain', 'ready'],
  );
  const info = handle.info();
  const [started, first, second, ready] = events;
  assert.equal(started.version, VERSION);
  assert.equal(started.googlePort, info.listeners.google.port);
  assert.equal(started.controlPort, info.listeners.control.port);
  assert.equal(started.proxyPort, handle.proxy!.port);
  assert.equal(started.dataDir, join(dir, 'data'));
  assert.equal(started.caFile, info.caFile);
  assert.deepEqual(started.timing, { scale: 1, delays: false });
  for (const [index, event] of [first, second].entries()) {
    assert.equal(event.customerId, info.domains[index].customerId);
    assert.equal(event.action, 'created');
    assert.equal(typeof event.durationMs, 'number');
  }
  assert.deepEqual(ready, { event: 'ready', ...info });
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, 'out', 'ready.json'), 'utf8')),
    ready,
  );
  assert.deepEqual(readdirSync(join(dir, 'out')), ['ready.json']);
});

test('GET /info on the control listener answers info(), and /health still answers', async (t) => {
  const { handle } = await start(t, { domains: [{ spec: EMPTY }] });
  const response = await fetch(`${handle.controlUrl}/info`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), handle.info());
  assert.equal((await fetch(`${handle.controlUrl}/health`)).status, 200);
});

test('the proxy tunnels admin.googleapis.com to the Google listener with a trusted chain', async (t) => {
  const { handle } = await start(t, { domains: [{ spec: EMPTY }] });
  const ca = readFileSync(handle.info().caFile, 'utf8');
  assert.equal(
    await tunnelGet(
      handle.proxy!.port,
      ca,
      '/admin/directory/v1/users?customer=my_customer',
    ),
    'HTTP/1.1 401 Unauthorized',
  );
});

test('POST /domains/{id}/tokens issues a token that the Directory API accepts', async (t) => {
  const { handle } = await start(t, { domains: [{ spec: EMPTY }] });
  const { customerId } = handle.info().domains[0];
  const tokens = `${handle.controlUrl}/domains/${customerId}/tokens`;
  const response = await post(tokens, { scopes: 'read' });
  assert.equal(response.status, 200);
  const { access_token: token, ...rest } = await response.json();
  assert.match(token, /^ya29\.mock\./);
  assert.deepEqual(rest, {
    token_type: 'Bearer',
    expires_in: 3600,
    scope: READ_SCOPES.join(' '),
  });
  const ca = readFileSync(handle.info().caFile, 'utf8');
  assert.equal(
    await tunnelGet(
      handle.proxy!.port,
      ca,
      '/admin/directory/v1/users?customer=my_customer&maxResults=1',
      token,
    ),
    'HTTP/1.1 200 OK',
  );
  assert.equal(
    (await post(tokens, { subject: `nobody@${PRIMARY}` })).status,
    400,
  );
  for (const ttlSeconds of [0, 3601, 1.5])
    assert.equal(
      (await post(tokens, { ttlSeconds })).status,
      400,
      `${ttlSeconds}`,
    );
});

test('close() closes all three listeners, and a second close() resolves', async (t) => {
  const dir = tempDir(t);
  const handle = await startServer(configIn(dir));
  const { google, control, proxy } = handle.info().listeners;
  const ports = [google.port, control.port, proxy!.port];
  for (const port of ports)
    assert.equal(await free(port), false, `port ${port}`);
  await handle.close();
  for (const port of ports)
    assert.equal(await free(port), true, `port ${port}`);
  await handle.close();
});

test('clientEnvironment maps wildcard hosts to loopback and names a lone key file', () => {
  const account = {
    out: '/out/key.json',
    clientEmail: 'mock@project.iam.gserviceaccount.com',
    clientId: '100000000000000000001',
    scopes: [],
  };
  const info: ServerInfo = {
    version: VERSION,
    ready: true,
    listeners: {
      google: { host: '0.0.0.0', port: 443 },
      control: { host: '0.0.0.0', port: 8080 },
      proxy: { host: '0.0.0.0', port: 3128, passthrough: false },
    },
    caFile: '/out/ca.pem',
    caBundleFile: '/out/ca-bundle.pem',
    dataDir: '/data',
    domains: [
      {
        customerId: 'C0abcdefg',
        primaryDomain: 'example.test',
        adminEmail: 'admin@example.test',
        action: 'created',
        serviceAccounts: [account],
      },
    ],
  };
  const control = 'http://127.0.0.1:8080';
  assert.deepEqual(clientEnvironment(info, control), {
    HTTPS_PROXY: 'http://127.0.0.1:3128',
    https_proxy: 'http://127.0.0.1:3128',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    NODE_EXTRA_CA_CERTS: '/out/ca.pem',
    SSL_CERT_FILE: '/out/ca-bundle.pem',
    REQUESTS_CA_BUNDLE: '/out/ca-bundle.pem',
    HTTPLIB2_CA_CERTS: '/out/ca-bundle.pem',
    CURL_CA_BUNDLE: '/out/ca-bundle.pem',
    ADMIN_SDK_MOCK_CONTROL: control,
    GOOGLE_APPLICATION_CREDENTIALS: '/out/key.json',
  });
  const bare = clientEnvironment(
    {
      ...info,
      listeners: { ...info.listeners, proxy: null },
      domains: [{ ...info.domains[0], serviceAccounts: [account, account] }],
    },
    control,
  );
  assert.equal(bare.HTTPS_PROXY, undefined);
  assert.equal(bare.https_proxy, undefined);
  assert.equal(bare.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(bare.NODE_EXTRA_CA_CERTS, '/out/ca.pem');
});

test('a failing fixtures file rejects startServer and frees every port', async (t) => {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, 'fixtures.json'),
    JSON.stringify({ users: [{ primaryEmail: `ada@${PRIMARY}` }] }),
  );
  const events: Event[] = [];
  await assert.rejects(
    startServer(
      configIn(dir, { domains: [{ spec: EMPTY, fixtures: 'fixtures.json' }] }),
      { log: (event) => events.push(event) },
    ),
    FixtureError,
  );
  const [started] = events;
  assert.equal(started.event, 'started');
  for (const port of [
    started.googlePort,
    started.controlPort,
    started.proxyPort,
  ] as number[])
    assert.equal(await free(port), true, `port ${port}`);
});
