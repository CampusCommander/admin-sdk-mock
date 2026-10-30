import type { SeedSpec } from '../seed/spec.ts';
import { withDefaults, type DomainSettings } from '../settings.ts';
import { openDatabase, row, rows, transaction } from './sqlite.ts';

export interface StoredDomain {
  customerId: string;
  primaryDomain: string;
  spec: SeedSpec;
  settings: DomainSettings;
  seededAt: number;
  createdAt: number;
}

export interface StoredServiceAccount {
  clientId: string;
  clientEmail: string;
  projectId: string;
  privateKeyId: string;
  publicKey: string;
  customerId: string;
}

export interface StoredToken {
  token: string;
  clientId: string;
  projectId: string;
  subject: string;
  customerId: string;
  scopes: string[];
  expiresAt: number;
}

/** The answer that a control route makes the Drive token exchange for a subject. */
export type DriveRefusal = 'invalid_grant' | 'unauthorized_client';

export interface Registry {
  addDomain(domain: StoredDomain, names: readonly string[]): void;
  getDomain(customerId: string): StoredDomain | undefined;
  domainForName(name: string): string | undefined;
  listDomains(): StoredDomain[];
  setSettings(customerId: string, settings: DomainSettings): void;
  setSeededAt(customerId: string, seededAt: number): void;
  deleteDomain(customerId: string): void;
  addServiceAccount(account: StoredServiceAccount): void;
  serviceAccountByEmail(email: string): StoredServiceAccount | undefined;
  setGrant(
    customerId: string,
    clientId: string,
    scopes: readonly string[],
  ): void;
  grant(customerId: string, clientId: string): string[] | undefined;
  saveToken(token: StoredToken): void;
  token(value: string): StoredToken | undefined;
  setDriveRefusal(
    customerId: string,
    subject: string,
    error: DriveRefusal,
  ): void;
  driveRefusal(customerId: string, subject: string): DriveRefusal | undefined;
  clearDriveRefusals(customerId: string): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS domains (
  customer_id TEXT PRIMARY KEY,
  primary_domain TEXT NOT NULL UNIQUE,
  spec TEXT NOT NULL,
  settings TEXT NOT NULL,
  seeded_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS domain_names (
  name TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES domains ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS service_accounts (
  client_id TEXT PRIMARY KEY,
  client_email TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  private_key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES domains ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS grants (
  customer_id TEXT NOT NULL REFERENCES domains ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  PRIMARY KEY (customer_id, client_id)
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES domains ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drive_refusals (
  customer_id TEXT NOT NULL REFERENCES domains ON DELETE CASCADE,
  subject TEXT NOT NULL,
  error TEXT NOT NULL,
  PRIMARY KEY (customer_id, subject)
);
`;

interface DomainRow {
  customer_id: string;
  primary_domain: string;
  spec: string;
  settings: string;
  seeded_at: number;
  created_at: number;
}

const toDomain = (value: DomainRow): StoredDomain => ({
  customerId: value.customer_id,
  primaryDomain: value.primary_domain,
  spec: JSON.parse(value.spec) as SeedSpec,
  settings: withDefaults(JSON.parse(value.settings)),
  seededAt: value.seeded_at,
  createdAt: value.created_at,
});

export function openRegistry(path: string): Registry {
  const db = openDatabase(path);
  db.exec(SCHEMA);
  return {
    addDomain(domain, names) {
      transaction(db, () => {
        db.prepare(
          'INSERT INTO domains (customer_id, primary_domain, spec, settings, seeded_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          domain.customerId,
          domain.primaryDomain.toLowerCase(),
          JSON.stringify(domain.spec),
          JSON.stringify(domain.settings),
          domain.seededAt,
          domain.createdAt,
        );
        const insert = db.prepare(
          'INSERT INTO domain_names (name, customer_id) VALUES (?, ?)',
        );
        for (const name of new Set(names.map((name) => name.toLowerCase())))
          insert.run(name, domain.customerId);
      });
    },
    getDomain(customerId) {
      const found = row<DomainRow>(
        db
          .prepare('SELECT * FROM domains WHERE customer_id = ?')
          .get(customerId),
      );
      return found && toDomain(found);
    },
    domainForName(name) {
      return row<{ customer_id: string }>(
        db
          .prepare('SELECT customer_id FROM domain_names WHERE name = ?')
          .get(name.toLowerCase()),
      )?.customer_id;
    },
    listDomains() {
      return rows<DomainRow>(
        db
          .prepare('SELECT * FROM domains ORDER BY created_at, customer_id')
          .all(),
      ).map(toDomain);
    },
    setSettings(customerId, settings) {
      db.prepare('UPDATE domains SET settings = ? WHERE customer_id = ?').run(
        JSON.stringify(settings),
        customerId,
      );
    },
    setSeededAt(customerId, seededAt) {
      db.prepare('UPDATE domains SET seeded_at = ? WHERE customer_id = ?').run(
        seededAt,
        customerId,
      );
    },
    deleteDomain(customerId) {
      db.prepare('DELETE FROM domains WHERE customer_id = ?').run(customerId);
    },
    addServiceAccount(account) {
      db.prepare(
        'INSERT INTO service_accounts (client_id, client_email, project_id, private_key_id, public_key, customer_id) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        account.clientId,
        account.clientEmail.toLowerCase(),
        account.projectId,
        account.privateKeyId,
        account.publicKey,
        account.customerId,
      );
    },
    serviceAccountByEmail(email) {
      const found = row<{
        client_id: string;
        client_email: string;
        project_id: string;
        private_key_id: string;
        public_key: string;
        customer_id: string;
      }>(
        db
          .prepare('SELECT * FROM service_accounts WHERE client_email = ?')
          .get(email.toLowerCase()),
      );
      return (
        found && {
          clientId: found.client_id,
          clientEmail: found.client_email,
          projectId: found.project_id,
          privateKeyId: found.private_key_id,
          publicKey: found.public_key,
          customerId: found.customer_id,
        }
      );
    },
    setGrant(customerId, clientId, scopes) {
      db.prepare(
        'INSERT INTO grants (customer_id, client_id, scopes) VALUES (?, ?, ?) ON CONFLICT (customer_id, client_id) DO UPDATE SET scopes = excluded.scopes',
      ).run(customerId, clientId, JSON.stringify([...scopes]));
    },
    grant(customerId, clientId) {
      const found = row<{ scopes: string }>(
        db
          .prepare(
            'SELECT scopes FROM grants WHERE customer_id = ? AND client_id = ?',
          )
          .get(customerId, clientId),
      );
      return found && (JSON.parse(found.scopes) as string[]);
    },
    saveToken(token) {
      db.prepare(
        'INSERT INTO tokens (token, client_id, project_id, subject, customer_id, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        token.token,
        token.clientId,
        token.projectId,
        token.subject,
        token.customerId,
        JSON.stringify(token.scopes),
        token.expiresAt,
      );
    },
    token(value) {
      const found = row<{
        token: string;
        client_id: string;
        project_id: string;
        subject: string;
        customer_id: string;
        scopes: string;
        expires_at: number;
      }>(db.prepare('SELECT * FROM tokens WHERE token = ?').get(value));
      return (
        found && {
          token: found.token,
          clientId: found.client_id,
          projectId: found.project_id,
          subject: found.subject,
          customerId: found.customer_id,
          scopes: JSON.parse(found.scopes) as string[],
          expiresAt: found.expires_at,
        }
      );
    },
    setDriveRefusal(customerId, subject, error) {
      db.prepare(
        'INSERT INTO drive_refusals (customer_id, subject, error) VALUES (?, ?, ?) ON CONFLICT (customer_id, subject) DO UPDATE SET error = excluded.error',
      ).run(customerId, subject.toLowerCase(), error);
    },
    driveRefusal(customerId, subject) {
      const found = row<{ error: string }>(
        db
          .prepare(
            'SELECT error FROM drive_refusals WHERE customer_id = ? AND subject = ?',
          )
          .get(customerId, subject.toLowerCase()),
      );
      return found?.error as DriveRefusal | undefined;
    },
    clearDriveRefusals(customerId) {
      db.prepare('DELETE FROM drive_refusals WHERE customer_id = ?').run(
        customerId,
      );
    },
    close() {
      db.close();
    },
  };
}
