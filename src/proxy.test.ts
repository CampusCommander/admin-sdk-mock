import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import test from 'node:test';
import { GOOGLE_HOSTS, isLoopbackHost, startProxy } from './proxy.ts';

/** A TCP server that answers every connection with one line naming itself. */
async function echoServer(name: string, host = '127.0.0.1') {
  const server = net.createServer((socket) => socket.end(`${name}\n`));
  server.listen(0, host);
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    close: () => server.close(),
  };
}

/** Send one CONNECT and return the status line plus any tunneled bytes. */
function connect(
  proxyPort: number,
  target: string,
): Promise<{ status: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (text += chunk));
    socket.on('end', () => {
      const [head, ...rest] = text.split('\r\n\r\n');
      resolve({ status: head.split('\r\n')[0], body: rest.join('\r\n\r\n') });
    });
    socket.on('error', reject);
  });
}

test('the proxy tunnels the five Google hostnames on port 443 to the target', async (t) => {
  const google = await echoServer('google');
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port: google.port },
    passthrough: false,
  });
  t.after(async () => {
    await proxy.close();
    google.close();
  });
  assert.deepEqual([...GOOGLE_HOSTS].sort(), [
    'admin.googleapis.com',
    'chromemanagement.googleapis.com',
    'oauth2.googleapis.com',
    'sheets.googleapis.com',
    'www.googleapis.com',
  ]);
  for (const host of GOOGLE_HOSTS) {
    const result = await connect(proxy.port, `${host}:443`);
    assert.equal(result.status, 'HTTP/1.1 200 Connection Established', host);
    assert.equal(result.body, 'google\n');
  }
  assert.equal(proxy.accepted.length, 5);
  assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('other targets get 403 without passthrough, and the proxy stays healthy', async (t) => {
  const google = await echoServer('google');
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port: google.port },
    passthrough: false,
  });
  t.after(async () => {
    await proxy.close();
    google.close();
  });
  for (const target of [
    'example.com:443',
    'admin.googleapis.com:8443',
    'evil.googleapis.com:443',
    'bad-target',
  ])
    assert.equal(
      (await connect(proxy.port, target)).status,
      'HTTP/1.1 403 Forbidden',
      target,
    );
  assert.equal(proxy.refused.length, 4);
  assert.equal(
    (await connect(proxy.port, 'admin.googleapis.com:443')).body,
    'google\n',
  );
});

/** The IPv4 addresses of this host that are neither loopback nor link-local. */
const outsideAddresses = [
  ...new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter(
        (address): address is NetworkInterfaceInfo =>
          address !== undefined &&
          !address.internal &&
          address.family === 'IPv4' &&
          !address.address.startsWith('169.254.'),
      )
      .map((address) => address.address),
  ),
];

/** Whether a connection to `host:port` delivers a line within two seconds. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2_000);
    socket.setEncoding('utf8');
    socket.on('data', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * An echo server on the first outside address that accepts a connection from this
 * host. A host can hold an address on an adapter that does not route to itself,
 * such as a point-to-point tunnel, so the fixture proves the address works
 * instead of trusting the first one it finds.
 */
async function reachableEchoServer(name: string) {
  for (const address of outsideAddresses) {
    const server = net.createServer((socket) => socket.end(`${name}\n`));
    try {
      server.listen(0, address);
      await once(server, 'listening');
    } catch {
      server.close();
      continue;
    }
    const port = (server.address() as AddressInfo).port;
    if (await answers(address, port))
      return { address, port, close: () => server.close() };
    await new Promise((resolve) => server.close(resolve));
  }
  return null;
}

test('passthrough tunnels other targets to themselves', async (t) => {
  const other = await reachableEchoServer('other');
  if (!other) {
    t.skip(
      'No IPv4 address outside loopback and link-local accepts a connection from this host.',
    );
    return;
  }
  const google = await echoServer('google');
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port: google.port },
    passthrough: true,
  });
  t.after(async () => {
    await proxy.close();
    google.close();
    other.close();
  });
  const target = `${other.address}:${other.port}`;
  const result = await connect(proxy.port, target);
  assert.equal(result.status, 'HTTP/1.1 200 Connection Established');
  assert.equal(result.body, 'other\n');
  assert.deepEqual(proxy.tunneled, [target]);
});

test('passthrough refuses loopback, link-local, and unspecified targets with 403', async (t) => {
  const google = await echoServer('google');
  const events: Record<string, unknown>[] = [];
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port: google.port },
    passthrough: true,
    log: (event) => events.push(event),
  });
  t.after(async () => {
    await proxy.close();
    google.close();
  });
  const port = google.port;
  const targets = [
    `127.0.0.1:${port}`,
    `127.255.0.9:${port}`,
    // Shorthand and numeric IPv4 forms that the resolver also dials as 127.0.0.1.
    `127.1:${port}`,
    `2130706433:${port}`,
    `0x7f.1:${port}`,
    `0177.0.0.1:${port}`,
    '169.254.169.254:80',
    `0.0.0.0:${port}`,
    `0:${port}`,
    `[::1]:${port}`,
    `[0:0:0:0:0:0:0:1]:${port}`,
    `[::1%lo]:${port}`,
    `[::]:${port}`,
    '[fe80::1]:80',
    '[fe80::1%eth0]:80',
    '[fe80::1%25eth0]:80',
    '[febf::1]:80',
    `[::ffff:127.0.0.1]:${port}`,
    `[::ffff:7f00:1]:${port}`,
    '[::ffff:169.254.169.254]:80',
    `localhost:${port}`,
    `LOCALHOST:${port}`,
    `localhost.:${port}`,
    `api.localhost:${port}`,
  ];
  for (const target of targets)
    assert.equal(
      (await connect(proxy.port, target)).status,
      'HTTP/1.1 403 Forbidden',
      target,
    );
  assert.deepEqual(proxy.counts(), {
    accepted: 0,
    refused: targets.length,
    tunneled: 0,
  });
  assert.deepEqual(proxy.refused, targets);
  assert.deepEqual(
    events,
    targets.map((target) => ({ event: 'proxy-refused', target })),
  );
});

test('isLoopbackHost names loopback hosts only', () => {
  for (const host of [
    '127.0.0.1',
    '127.0.0.2',
    '127.1',
    '::1',
    '::ffff:127.0.0.1',
    'localhost',
    'LOCALHOST',
  ])
    assert.equal(isLoopbackHost(host), true, host);
  // name.123 is no valid URL host, and fe80::zz is no IPv6 address. Neither is loopback.
  for (const host of [
    '0.0.0.0',
    '::',
    '192.168.1.5',
    'example.com',
    'name.123',
    'fe80::zz',
  ])
    assert.equal(isLoopbackHost(host), false, host);
});

test('a request that is not CONNECT gets 405', async (t) => {
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port: 1 },
    passthrough: false,
  });
  t.after(() => proxy.close());
  const response = await new Promise<http.IncomingMessage>((resolve) =>
    http.get({ host: '127.0.0.1', port: proxy.port, path: '/' }, resolve),
  );
  assert.equal(response.statusCode, 405);
  response.resume();
});

test('an unreachable target closes the client socket with 502', async (t) => {
  const closed = net.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = (closed.address() as AddressInfo).port;
  closed.close();
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port },
    passthrough: false,
  });
  t.after(() => proxy.close());
  assert.equal(
    (await connect(proxy.port, 'admin.googleapis.com:443')).status,
    'HTTP/1.1 502 Bad Gateway',
  );
});

test('the proxy keeps running totals and only the last 1,000 targets of each list', async (t) => {
  const google = await echoServer('google');
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port: google.port },
    passthrough: false,
  });
  t.after(async () => {
    await proxy.close();
    google.close();
  });
  const targets = Array.from({ length: 1_005 }, (_, n) => `h${n}.test:443`);
  // The five oldest targets go first, one at a time, so they are the ones the list drops.
  for (const target of targets.slice(0, 5)) await connect(proxy.port, target);
  for (let start = 5; start < targets.length; start += 50)
    await Promise.all(
      targets
        .slice(start, start + 50)
        .map((target) => connect(proxy.port, target)),
    );
  await connect(proxy.port, 'admin.googleapis.com:443');
  assert.deepEqual(proxy.counts(), {
    accepted: 1,
    refused: 1_005,
    tunneled: 0,
  });
  assert.equal(proxy.refused.length, 1_000);
  assert.deepEqual(new Set(proxy.refused), new Set(targets.slice(5)));
  assert.deepEqual(proxy.accepted, ['admin.googleapis.com:443']);
});

test('a Google hostname with a trailing dot tunnels to the mock, even with passthrough', async (t) => {
  const google = await echoServer('google');
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port: google.port },
    passthrough: true,
  });
  t.after(async () => {
    await proxy.close();
    google.close();
  });
  const result = await connect(proxy.port, 'admin.googleapis.com.:443');
  assert.equal(result.status, 'HTTP/1.1 200 Connection Established');
  assert.equal(result.body, 'google\n');
  assert.deepEqual(proxy.counts(), { accepted: 1, refused: 0, tunneled: 0 });
});

test('a host with an empty label is refused, even with passthrough', async (t) => {
  const google = await echoServer('google');
  const local = await echoServer('local');
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port: google.port },
    passthrough: true,
  });
  t.after(async () => {
    await proxy.close();
    google.close();
    local.close();
  });
  for (const target of [
    'admin.googleapis.com..:443',
    `localhost..:${local.port}`,
    `.localhost:${local.port}`,
    `example..com:${local.port}`,
  ]) {
    const result = await connect(proxy.port, target);
    assert.equal(result.status, 'HTTP/1.1 403 Forbidden', target);
  }
  assert.deepEqual(proxy.counts(), { accepted: 0, refused: 4, tunneled: 0 });
});

test('close() returns the same promise each time', async () => {
  const proxy = await startProxy({
    host: '127.0.0.1',
    port: 0,
    target: { host: '127.0.0.1', port: 1 },
    passthrough: false,
  });
  const first = proxy.close();
  assert.equal(proxy.close(), first);
  await first;
  await proxy.close();
});
