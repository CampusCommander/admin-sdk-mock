import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import test from 'node:test';
import { GOOGLE_HOSTS, startProxy } from './proxy.ts';

/** A TCP server that answers every connection with one line naming itself. */
async function echoServer(name: string) {
  const server = net.createServer((socket) => socket.end(`${name}\n`));
  server.listen(0, '127.0.0.1');
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

test('the proxy tunnels the four Google hostnames on port 443 to the target', async (t) => {
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
    'www.googleapis.com',
  ]);
  for (const host of GOOGLE_HOSTS) {
    const result = await connect(proxy.port, `${host}:443`);
    assert.equal(result.status, 'HTTP/1.1 200 Connection Established', host);
    assert.equal(result.body, 'google\n');
  }
  assert.equal(proxy.accepted.length, 4);
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

test('passthrough tunnels other targets to themselves', async (t) => {
  const google = await echoServer('google');
  const other = await echoServer('other');
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
  const result = await connect(proxy.port, `127.0.0.1:${other.port}`);
  assert.equal(result.status, 'HTTP/1.1 200 Connection Established');
  assert.equal(result.body, 'other\n');
  assert.deepEqual(proxy.tunneled, [`127.0.0.1:${other.port}`]);
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
