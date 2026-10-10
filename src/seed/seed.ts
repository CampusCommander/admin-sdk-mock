import type { DatabaseSync } from 'node:sqlite';
import { createRandom } from '../random.ts';
import { row, transaction } from '../store/sqlite.ts';
import { DAY_MS, type SeedContext } from './context.ts';
import { seedDevices } from './devices.ts';
import { seedGroups } from './groups.ts';
import { buildLayout } from './layout.ts';
import type { ResolvedSpec } from './spec.ts';
import { seedUsers } from './users.ts';

export interface SeedResult {
  counts: SeedCounts;
  adminEmail: string;
  durationMs: number;
}

export interface SeedCounts {
  orgUnits: number;
  users: number;
  devices: number;
  groups: number;
  memberships: number;
}

/** Count the entities that a domain database holds. */
export function domainCounts(db: DatabaseSync): SeedCounts {
  const count = (table: string) =>
    Number(
      row<{ n: number }>(db.prepare(`SELECT count(*) AS n FROM ${table}`).get())
        ?.n ?? 0,
    );
  return {
    orgUnits: count('orgunits'),
    users: count('users'),
    devices: count('devices'),
    groups: count('groups'),
    memberships: count('group_members'),
  };
}

/** The empty tier's one user: the super administrator `admin@<primary domain>`. */
function seedAdministrator({ spec, seededAt, db }: SeedContext): string {
  const email = `admin@${spec.primaryDomain}`;
  db.prepare(
    "INSERT INTO users (id, primary_email, given_name, family_name, full_name, org_unit_path, is_admin, suspended, role, creation_time, ord) VALUES (?, ?, 'Admin', 'Account', 'Admin Account', '/', 1, 0, 'admin', ?, 0)",
  ).run(
    `1${createRandom(`users/${spec.seed}`).string(20, '0123456789')}`,
    email,
    seededAt - 1000 * DAY_MS,
  );
  return email;
}

/** Write one complete domain into an empty domain database. */
export function seedDomain(
  db: DatabaseSync,
  spec: ResolvedSpec,
  seededAt: number,
): SeedResult {
  const started = performance.now();
  const layout = buildLayout(spec);
  const ctx = { spec, layout, seededAt, db };
  const adminEmail = transaction(db, () => {
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('spec', JSON.stringify(spec));
    meta.run('seededAt', String(seededAt));
    meta.run('deviceCount', String(spec.counts.devices));
    const domain = db.prepare(
      'INSERT INTO domains (domain_name, is_primary, verified, creation_time, alias_of) VALUES (?, ?, ?, ?, ?)',
    );
    const created = seededAt - 3000 * DAY_MS;
    domain.run(spec.primaryDomain, 1, 1, created, null);
    if (spec.studentDomain !== spec.primaryDomain)
      domain.run(spec.studentDomain, 0, 1, created + 30 * DAY_MS, null);
    domain.run(
      spec.aliasDomain,
      0,
      1,
      created + 60 * DAY_MS,
      spec.primaryDomain,
    );
    const unit = db.prepare(
      'INSERT INTO orgunits (org_unit_id, path, name, description, parent_id, parent_path, depth, kind, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const empty = spec.tier === 'empty';
    (empty ? [layout.root] : [layout.root, ...layout.units]).forEach(
      (node, ord) =>
        unit.run(
          node.orgUnitId,
          node.path,
          node.name,
          node.description,
          node.parentId,
          node.parentPath,
          node.depth,
          node.kind,
          ord,
        ),
    );
    if (empty) return seedAdministrator(ctx);
    const index = seedUsers(ctx);
    seedDevices(ctx, index);
    seedGroups(ctx);
    return index.adminEmail;
  });
  return {
    counts: domainCounts(db),
    adminEmail,
    durationMs: Math.round(performance.now() - started),
  };
}
