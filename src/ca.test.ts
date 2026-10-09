import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, statSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCertificates, ensureCertificates, GOOGLE_HOSTS } from './ca.ts';

test('the server certificate covers every Google hostname and chains to the CA', () => {
  const { caCert, serverCert } = createCertificates();
  const ca = new X509Certificate(caCert);
  const server = new X509Certificate(serverCert);
  for (const host of GOOGLE_HOSTS) assert.equal(server.checkHost(host), host);
  assert.equal(server.checkHost('evil.example'), undefined);
  assert.equal(server.verify(ca.publicKey), true);
  assert.equal(ca.ca, true);
  assert.equal(server.ca, false);
});

test('a client that trusts only the mock CA completes a handshake for each hostname', async () => {
  const certs = createCertificates();
  const server = https.createServer(
    { cert: certs.serverCert, key: certs.serverKey },
    (_request, response) => response.end('ok'),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    for (const host of GOOGLE_HOSTS) {
      const body = await new Promise<string>((resolve, reject) => {
        https
          .get(
            {
              host: '127.0.0.1',
              port,
              path: '/',
              servername: host,
              headers: { host },
              ca: certs.caCert,
            },
            (response) => {
              let text = '';
              response.on('data', (chunk) => (text += chunk));
              response.on('end', () => resolve(text));
            },
          )
          .on('error', reject);
      });
      assert.equal(body, 'ok');
    }
  } finally {
    server.close();
  }
});

test('ensureCertificates creates the files once and then reuses them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mock-ca-'));
  const first = ensureCertificates(directory);
  const second = ensureCertificates(directory);
  assert.equal(second.caCert, first.caCert);
  assert.equal(second.serverKey, first.serverKey);
  assert.equal(statSync(join(directory, 'ca-key.pem')).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'server-key.pem')).mode & 0o777, 0o600);
});
