import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import forge from 'node-forge';
import { writeAtomically } from './write-file.ts';

export const GOOGLE_HOSTS = [
  'oauth2.googleapis.com',
  'admin.googleapis.com',
  'www.googleapis.com',
  'chromemanagement.googleapis.com',
  'sheets.googleapis.com',
] as const;

export interface Certificates {
  caCert: string;
  serverCert: string;
  serverKey: string;
}

const DAY = 86_400_000;
const CA_SUBJECT = [
  { name: 'commonName', value: 'Admin SDK Mock CA' },
  { name: 'organizationName', value: 'Campus Commander test infrastructure' },
];

function keyPair(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

/** A positive serial number with 16 random bytes. */
function serialNumber(): string {
  return `01${randomBytes(15).toString('hex')}`;
}

/** Issue a leaf for every Google hostname under the CA that `caKeyPem` signs. */
function issueServerCertificate(
  caKeyPem: string,
  caCertPem: string,
  now: Date,
): { serverCert: string; serverKey: string } {
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const server = keyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(server.publicKey);
  cert.serialNumber = serialNumber();
  cert.validity.notBefore = new Date(now.getTime() - DAY);
  cert.validity.notAfter = new Date(now.getTime() + 825 * DAY);
  cert.setSubject([{ name: 'commonName', value: 'admin.googleapis.com' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: GOOGLE_HOSTS.map((value) => ({ type: 2, value })),
    },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    serverCert: forge.pki.certificateToPem(cert),
    serverKey: server.privateKey,
  };
}

/** Create a CA and one server certificate for the five Google hostnames. */
export function createCertificates(
  now = new Date(),
): Certificates & { caKey: string } {
  const ca = keyPair();
  const caKey = forge.pki.privateKeyFromPem(ca.privateKey);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = forge.pki.publicKeyFromPem(ca.publicKey);
  caCert.serialNumber = serialNumber();
  caCert.validity.notBefore = new Date(now.getTime() - DAY);
  caCert.validity.notAfter = new Date(now.getTime() + 3650 * DAY);
  caCert.setSubject(CA_SUBJECT);
  caCert.setIssuer(CA_SUBJECT);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKey, forge.md.sha256.create());

  const caCertPem = forge.pki.certificateToPem(caCert);
  return {
    caCert: caCertPem,
    caKey: ca.privateKey,
    ...issueServerCertificate(ca.privateKey, caCertPem, now),
  };
}

const FILES = {
  caCert: 'ca.pem',
  caKey: 'ca-key.pem',
  serverCert: 'server.pem',
  serverKey: 'server-key.pem',
} as const;

/** Whether a leaf certificate names every supported hostname. */
function coversEveryHost(serverCert: string): boolean {
  const leaf = new X509Certificate(serverCert);
  return GOOGLE_HOSTS.every((host) => leaf.checkHost(host) === host);
}

/**
 * Load the certificates from `directory`, or create them on first start. A leaf
 * that an earlier release wrote names fewer hosts, so this replaces it with a
 * leaf for every supported hostname under the CA that already signed it. The CA
 * stays the same, so a client that trusts the old CA still trusts the new leaf.
 */
export function ensureCertificates(
  directory: string,
  now = new Date(),
): Certificates {
  const path = (name: keyof typeof FILES) => join(directory, FILES[name]);
  const names = Object.keys(FILES) as (keyof typeof FILES)[];
  if (names.every((name) => existsSync(path(name)))) {
    const caCert = readFileSync(path('caCert'), 'utf8');
    const serverCert = readFileSync(path('serverCert'), 'utf8');
    const serverKey = readFileSync(path('serverKey'), 'utf8');
    if (coversEveryHost(serverCert)) return { caCert, serverCert, serverKey };
    const reissued = issueServerCertificate(
      readFileSync(path('caKey'), 'utf8'),
      caCert,
      now,
    );
    writeAtomically(path('serverCert'), reissued.serverCert, 0o644);
    writeAtomically(path('serverKey'), reissued.serverKey, 0o600);
    return { caCert, ...reissued };
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const created = createCertificates(now);
  writeFileSync(path('caCert'), created.caCert, { mode: 0o644 });
  writeFileSync(path('caKey'), created.caKey, { mode: 0o600 });
  writeFileSync(path('serverCert'), created.serverCert, { mode: 0o644 });
  writeFileSync(path('serverKey'), created.serverKey, { mode: 0o600 });
  return {
    caCert: created.caCert,
    serverCert: created.serverCert,
    serverKey: created.serverKey,
  };
}
