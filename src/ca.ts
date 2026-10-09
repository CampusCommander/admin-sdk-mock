import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import forge from 'node-forge';

export const GOOGLE_HOSTS = [
  'oauth2.googleapis.com',
  'admin.googleapis.com',
  'www.googleapis.com',
  'chromemanagement.googleapis.com',
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

/** Create a CA and one server certificate for the four Google hostnames. */
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

  const server = keyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(server.publicKey);
  cert.serialNumber = serialNumber();
  cert.validity.notBefore = new Date(now.getTime() - DAY);
  cert.validity.notAfter = new Date(now.getTime() + 825 * DAY);
  cert.setSubject([{ name: 'commonName', value: 'admin.googleapis.com' }]);
  cert.setIssuer(CA_SUBJECT);
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
    caCert: forge.pki.certificateToPem(caCert),
    caKey: ca.privateKey,
    serverCert: forge.pki.certificateToPem(cert),
    serverKey: server.privateKey,
  };
}

const FILES = {
  caCert: 'ca.pem',
  caKey: 'ca-key.pem',
  serverCert: 'server.pem',
  serverKey: 'server-key.pem',
} as const;

/** Load the certificates from `directory`, or create them on first start. */
export function ensureCertificates(
  directory: string,
  now = new Date(),
): Certificates {
  const path = (name: keyof typeof FILES) => join(directory, FILES[name]);
  const names = Object.keys(FILES) as (keyof typeof FILES)[];
  if (names.every((name) => existsSync(path(name))))
    return {
      caCert: readFileSync(path('caCert'), 'utf8'),
      serverCert: readFileSync(path('serverCert'), 'utf8'),
      serverKey: readFileSync(path('serverKey'), 'utf8'),
    };
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
