import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import type { Registry } from '../store/registry.ts';
import { TOKEN_URI } from './scopes.ts';

/** The JSON key file format that Google issues for a service account. */
export interface ServiceAccountFile {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
  universe_domain: 'googleapis.com';
}

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Create a key pair, store its public key, and return the key file. */
export function issueServiceAccount(
  registry: Registry,
  customerId: string,
  projectId?: string,
): ServiceAccountFile {
  const project =
    projectId ?? `admin-sdk-mock-${randomInt(100_000, 1_000_000)}`;
  if (!PROJECT_PATTERN.test(project))
    throw new AccountError(
      'projectId must be 6 to 30 lower-case letters, digits, or hyphens, and start with a letter.',
    );
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const clientId = `1${Array.from({ length: 20 }, () => randomInt(0, 10)).join('')}`;
  const clientEmail = `mock-${randomBytes(3).toString('hex')}@${project}.iam.gserviceaccount.com`;
  const privateKeyId = randomBytes(20).toString('hex');
  registry.addServiceAccount({
    clientId,
    clientEmail,
    projectId: project,
    privateKeyId,
    publicKey,
    customerId,
  });
  return {
    type: 'service_account',
    project_id: project,
    private_key_id: privateKeyId,
    private_key: privateKey,
    client_email: clientEmail,
    client_id: clientId,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: TOKEN_URI,
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(clientEmail)}`,
    universe_domain: 'googleapis.com',
  };
}
