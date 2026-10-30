import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import forge from 'node-forge';
import { createCertificates, ensureCertificates, GOOGLE_HOSTS } from './ca.ts';
import { startHarness } from './testing/harness.ts';

/** The hostnames that the 0.2.0 leaf covered: every one but the Sheets host. */
const PREDECESSOR_HOSTS = GOOGLE_HOSTS.filter(
  (host) => host !== 'sheets.googleapis.com',
);

/**
 * Write the four certificate files the way 0.2.0 left them: one CA and a leaf
 * that names the four hosts of that release. The CA key signs the rewritten leaf,
 * so the directory is a faithful predecessor and keeps a usable CA key.
 */
function writePredecessorCertificates(directory: string) {
  const created = createCertificates();
  const leaf = forge.pki.certificateFromPem(created.serverCert);
  leaf.setExtensions([
    ...leaf.extensions.filter(
      (extension) => extension.name !== 'subjectAltName',
    ),
    {
      name: 'subjectAltName',
      altNames: PREDECESSOR_HOSTS.map((value) => ({ type: 2, value })),
    },
  ]);
  leaf.sign(
    forge.pki.privateKeyFromPem(created.caKey),
    forge.md.sha256.create(),
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'ca.pem'), created.caCert);
  writeFileSync(join(directory, 'ca-key.pem'), created.caKey);
  writeFileSync(
    join(directory, 'server.pem'),
    forge.pki.certificateToPem(leaf),
  );
  writeFileSync(join(directory, 'server-key.pem'), created.serverKey);
  return created;
}

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

test('ensureCertificates reissues a predecessor leaf under the retained CA', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mock-ca-'));
  const caDirectory = join(directory, 'ca');
  const previous = writePredecessorCertificates(caDirectory);
  const upgraded = ensureCertificates(caDirectory);
  assert.equal(upgraded.caCert, previous.caCert, 'the CA and its trust stay');
  const ca = new X509Certificate(upgraded.caCert);
  const leaf = new X509Certificate(upgraded.serverCert);
  for (const host of GOOGLE_HOSTS) assert.equal(leaf.checkHost(host), host);
  assert.equal(leaf.verify(ca.publicKey), true);
  assert.equal(
    readFileSync(join(caDirectory, 'server.pem'), 'utf8'),
    upgraded.serverCert,
  );
  assert.equal(
    statSync(join(caDirectory, 'server-key.pem')).mode & 0o777,
    0o600,
  );
  assert.equal(ensureCertificates(caDirectory).serverCert, upgraded.serverCert);
});

test('a Sheets call passes hostname verification after a certificate upgrade', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-sdk-mock-'));
  const previous = writePredecessorCertificates(join(dataDir, 'ca'));
  const harness = await startHarness({ dataDir });
  t.after(() => harness.close());
  assert.equal(harness.mock.certificates.caCert, previous.caCert);
  const sheets = await harness.request({
    host: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/upgrade-test',
  });
  assert.equal(sheets.status, 401);
  const admin = await harness.request({
    host: 'admin.googleapis.com',
    path: '/admin/directory/v1/users',
  });
  assert.equal(admin.status, 401);
});
