import type { DatabaseSync } from 'node:sqlite';
import { row, transaction } from '../store/sqlite.ts';
import { DAY_MS } from './context.ts';
import { seedDevices } from './devices.ts';
import { buildLayout } from './layout.ts';
import type { ResolvedSpec } from './spec.ts';
import { seedUsers } from './users.ts';

export interface SeedResult {
  counts: { orgUnits: number; users: number; devices: number };
  adminEmail: string;
  durationMs: number;
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
  const users = transaction(db, () => {
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
    [layout.root, ...layout.units].forEach((node, ord) =>
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
    const index = seedUsers(ctx);
    seedDevices(ctx, index);
    return index;
  });
  const count = (table: string) =>
    Number(
      row<{ n: number }>(db.prepare(`SELECT count(*) AS n FROM ${table}`).get())
        ?.n ?? 0,
    );
  return {
    counts: {
      orgUnits: count('orgunits'),
      users: count('users'),
      devices: count('devices'),
    },
    adminEmail: users.adminEmail,
    durationMs: Math.round(performance.now() - started),
  };
}
