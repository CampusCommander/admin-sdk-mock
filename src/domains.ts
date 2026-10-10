import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { OpenDomain } from './http/types.ts';
import { applyFixtures, type Fixtures } from './seed/fixtures.ts';
import { domainCounts, seedDomain, type SeedResult } from './seed/seed.ts';
import {
  resolveSpec,
  SpecError,
  type ResolvedSpec,
  type SeedSpec,
} from './seed/spec.ts';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  SettingsError,
  type DomainSettings,
} from './settings.ts';
import { openDomainDb } from './store/domain-db.ts';
import type { Registry, StoredDomain } from './store/registry.ts';
import { rows, transaction } from './store/sqlite.ts';

export class DomainError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
  }
}

/** A parsed fixtures file and the name that its errors carry. */
export interface DomainFixtures {
  file: string;
  data: Fixtures;
}

export interface Domains {
  get(customerId: string): OpenDomain | undefined;
  create(
    input: unknown,
    now: number,
    options?: { fixtures?: DomainFixtures },
  ): { domain: OpenDomain; result: SeedResult };
  reset(customerId: string, now: number): SeedResult;
  delete(customerId: string): void;
  list(): StoredDomain[];
  updateSettings(customerId: string, patch: unknown): DomainSettings;
  closeAll(): void;
}

/** Seed a domain, then apply and store its fixtures in one transaction. */
function seedWithFixtures(
  db: DatabaseSync,
  spec: ResolvedSpec,
  now: number,
  fixtures: DomainFixtures | undefined,
): SeedResult {
  const result = seedDomain(db, spec, now);
  if (!fixtures) return result;
  transaction(db, () => {
    applyFixtures(db, spec, fixtures.data, now, fixtures.file);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('fixtures', ?), ('fixturesFile', ?)",
    ).run(JSON.stringify(fixtures.data), fixtures.file);
  });
  return { ...result, counts: domainCounts(db) };
}

/** The fixtures that a domain database stores, if any. */
function storedFixtures(db: DatabaseSync): DomainFixtures | undefined {
  const meta = new Map(
    rows<{ key: string; value: string }>(
      db
        .prepare(
          "SELECT key, value FROM meta WHERE key IN ('fixtures', 'fixturesFile')",
        )
        .all(),
    ).map((entry) => [entry.key, entry.value]),
  );
  const data = meta.get('fixtures');
  const file = meta.get('fixturesFile');
  return data === undefined || file === undefined
    ? undefined
    : { file, data: JSON.parse(data) as Fixtures };
}

export function createDomains(dataDir: string, registry: Registry): Domains {
  const directory = join(dataDir, 'domains');
  mkdirSync(directory, { recursive: true });
  const open = new Map<string, OpenDomain>();
  const fileFor = (customerId: string) =>
    join(directory, `${customerId}.sqlite`);
  const removeFiles = (customerId: string) => {
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(`${fileFor(customerId)}${suffix}`, { force: true });
  };
  const close = (customerId: string) => {
    open.get(customerId)?.db.close();
    open.delete(customerId);
  };
  const missing = (customerId: string) =>
    new DomainError(404, `Domain ${customerId} does not exist.`);

  const domains: Domains = {
    get(customerId) {
      const cached = open.get(customerId);
      if (cached) return cached;
      const record = registry.getDomain(customerId);
      if (!record || !existsSync(fileFor(customerId))) return undefined;
      const domain: OpenDomain = {
        customerId,
        record,
        spec: resolveSpec(record.spec),
        db: openDomainDb(fileFor(customerId)),
      };
      open.set(customerId, domain);
      return domain;
    },
    create(input, now, options) {
      let spec;
      try {
        spec = resolveSpec(input);
      } catch (error) {
        if (error instanceof SpecError)
          throw new DomainError(400, error.message);
        throw error;
      }
      if (registry.getDomain(spec.customerId))
        throw new DomainError(
          409,
          `Domain ${spec.customerId} already exists. Use a different seed.`,
        );
      const names = [spec.primaryDomain, spec.studentDomain, spec.aliasDomain];
      for (const name of names)
        if (registry.domainForName(name))
          throw new DomainError(
            409,
            `The domain name ${name} is in use. Pass a different name.`,
          );
      removeFiles(spec.customerId);
      const db = openDomainDb(fileFor(spec.customerId));
      let result: SeedResult;
      try {
        result = seedWithFixtures(db, spec, now, options?.fixtures);
      } catch (error) {
        db.close();
        removeFiles(spec.customerId);
        throw error;
      }
      const record: StoredDomain = {
        customerId: spec.customerId,
        primaryDomain: spec.primaryDomain,
        spec: JSON.parse(JSON.stringify(input)) as SeedSpec,
        settings: DEFAULT_SETTINGS,
        seededAt: now,
        createdAt: now,
      };
      registry.addDomain(record, names);
      const domain: OpenDomain = {
        customerId: spec.customerId,
        record,
        spec,
        db,
      };
      open.set(spec.customerId, domain);
      return { domain, result };
    },
    reset(customerId, now) {
      const record = registry.getDomain(customerId);
      if (!record) throw missing(customerId);
      const current = domains.get(customerId);
      const fixtures = current ? storedFixtures(current.db) : undefined;
      close(customerId);
      removeFiles(customerId);
      const spec = resolveSpec(record.spec);
      const db = openDomainDb(fileFor(customerId));
      const result = seedWithFixtures(db, spec, now, fixtures);
      registry.setSeededAt(customerId, now);
      open.set(customerId, {
        customerId,
        record: { ...record, seededAt: now },
        spec,
        db,
      });
      return result;
    },
    delete(customerId) {
      if (!registry.getDomain(customerId)) throw missing(customerId);
      close(customerId);
      removeFiles(customerId);
      registry.deleteDomain(customerId);
    },
    list: () => registry.listDomains(),
    updateSettings(customerId, patch) {
      const domain = domains.get(customerId);
      if (!domain) throw missing(customerId);
      let settings: DomainSettings;
      try {
        settings = mergeSettings(domain.record.settings, patch);
      } catch (error) {
        if (error instanceof SettingsError)
          throw new DomainError(400, error.message);
        throw error;
      }
      registry.setSettings(customerId, settings);
      domain.record = { ...domain.record, settings };
      return settings;
    },
    closeAll() {
      for (const customerId of [...open.keys()]) close(customerId);
    },
  };
  return domains;
}
