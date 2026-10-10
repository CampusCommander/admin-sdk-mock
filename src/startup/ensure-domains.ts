import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AccountError,
  issueServiceAccount,
  type ServiceAccountFile,
} from '../auth/accounts.ts';
import { ConfigError, scopesFor, type DomainEntry } from '../config/config.ts';
import { DomainError } from '../domains.ts';
import { FaultError } from '../faults/faults.ts';
import type { Mock } from '../mock.ts';
import { loadFixtures } from '../seed/fixtures.ts';
import { resolveSpec } from '../seed/spec.ts';
import { DEFAULT_SETTINGS, mergeSettings } from '../settings.ts';
import type { StoredServiceAccount } from '../store/registry.ts';
import { row } from '../store/sqlite.ts';
import { writeSecret } from '../write-file.ts';

export interface EnsuredServiceAccount {
  out: string;
  clientEmail: string;
  clientId: string;
  scopes: string[];
}

export interface EnsuredDomain {
  customerId: string;
  primaryDomain: string;
  adminEmail: string;
  action: 'created' | 'kept' | 'reset';
  serviceAccounts: EnsuredServiceAccount[];
}

const restart = (path: string, what: string) =>
  new ConfigError([
    `${path}.${what} changed since the domain was created. Set onStart to reset or delete the data directory.`,
  ]);

/** Run a domain step, and report a DomainError or AccountError as a ConfigError at `label`. */
function step<T>(label: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof DomainError || error instanceof AccountError)
      throw new ConfigError([`${label}: ${error.message}`]);
    throw error;
  }
}

/** Read an existing key file whose account belongs to this customer, or null. */
function reusableKey(
  mock: Mock,
  out: string,
  customerId: string,
): { file: ServiceAccountFile; account: StoredServiceAccount } | null {
  if (!existsSync(out)) return null;
  try {
    const file = JSON.parse(readFileSync(out, 'utf8')) as ServiceAccountFile;
    const account = mock.registry.serviceAccountByEmail(file.client_email);
    return account &&
      account.customerId === customerId &&
      account.clientId === file.client_id &&
      typeof file.private_key === 'string'
      ? { file, account }
      : null;
  } catch {
    return null;
  }
}

/** Create, keep, or reset one configured domain, then apply its settings, faults, and service accounts. */
export function ensureDomain(
  mock: Mock,
  entry: DomainEntry,
  index: number,
  defaults: Record<string, unknown>,
  now: number,
): EnsuredDomain {
  const path = `domains[${index}]`;
  const spec = resolveSpec(entry.spec);
  const { customerId } = spec;
  const fixtures = entry.fixtures
    ? { file: entry.fixtures, data: loadFixtures(entry.fixtures) }
    : undefined;
  const create = () =>
    step(path, () => mock.domains.create(entry.spec, now, { fixtures }));
  const existing = mock.domains.get(customerId);
  let action: EnsuredDomain['action'] = 'created';
  if (!existing) create();
  else if (entry.onStart === 'reset') {
    // Deleting the domain cascades to its service accounts. Keep the ones whose key files remain.
    const kept = new Map(
      entry.serviceAccounts.flatMap((account) => {
        const key = reusableKey(mock, account.out, customerId);
        return key ? [[key.account.clientId, key.account] as const] : [];
      }),
    );
    mock.domains.delete(customerId);
    create();
    for (const account of kept.values())
      mock.registry.addServiceAccount(account);
    action = 'reset';
  } else {
    const sameSpec =
      JSON.stringify(resolveSpec(existing.record.spec)) ===
      JSON.stringify(spec);
    if (!sameSpec) throw restart(path, 'spec');
    const stored = row<{ value: string }>(
      existing.db
        .prepare("SELECT value FROM meta WHERE key = 'fixtures'")
        .get(),
    );
    const sameFixtures =
      (stored?.value ?? null) ===
      (fixtures ? JSON.stringify(fixtures.data) : null);
    if (!sameFixtures) throw restart(path, 'fixtures');
    action = 'kept';
  }

  // resolveConfig already checked this merge. A full settings object replaces every stored value.
  mock.domains.updateSettings(
    customerId,
    mergeSettings(mergeSettings(DEFAULT_SETTINGS, defaults), entry.settings),
  );

  mock.faults.clear(customerId);
  const faultErrors: string[] = [];
  entry.faults.forEach((rule, n) => {
    try {
      mock.faults.add(customerId, rule);
    } catch (error) {
      if (!(error instanceof FaultError)) throw error;
      faultErrors.push(`${path}.faults[${n}]: ${error.message}`);
    }
  });
  if (faultErrors.length > 0) throw new ConfigError(faultErrors);

  const serviceAccounts = entry.serviceAccounts.map((account, n) => {
    const scopes = scopesFor(account.scopes);
    const file =
      reusableKey(mock, account.out, customerId)?.file ??
      step(`${path}.serviceAccounts[${n}]`, () =>
        issueServiceAccount(mock.registry, customerId, account.projectId),
      );
    mock.registry.setGrant(customerId, file.client_id, scopes);
    mkdirSync(dirname(account.out), { recursive: true });
    writeSecret(account.out, `${JSON.stringify(file, null, 2)}\n`);
    return {
      out: account.out,
      clientEmail: file.client_email,
      clientId: file.client_id,
      scopes,
    };
  });

  return {
    customerId,
    primaryDomain: spec.primaryDomain,
    adminEmail: `admin@${spec.primaryDomain}`,
    action,
    serviceAccounts,
  };
}
