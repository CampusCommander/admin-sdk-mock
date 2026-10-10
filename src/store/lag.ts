import type { DatabaseSync } from 'node:sqlite';
import { row, rows } from './sqlite.ts';

/** Each table whose lists lag writes, and its key column. */
export const LAGGED = {
  orgunits: 'org_unit_id',
  users: 'id',
  deleted_users: 'id',
  devices: 'device_id',
} as const;
export type LaggedTable = keyof typeof LAGGED;

/** Before-image indexes that keep the list sorts on indexes. */
const PRIOR_INDEXES: Readonly<Record<LaggedTable, readonly string[]>> = {
  orgunits: ['parent_id, ord', 'path'],
  users: ['primary_email', 'ord'],
  deleted_users: ['primary_email'],
  devices: ['org_unit_path, ord', 'ord'],
};

const TABLES = Object.keys(LAGGED) as LaggedTable[];
const columnCache = new WeakMap<DatabaseSync, Map<string, string[]>>();

/** The column names of a table in declaration order. */
export function columnsOf(db: DatabaseSync, table: string): string[] {
  let cache = columnCache.get(db);
  if (!cache) {
    cache = new Map();
    columnCache.set(db, cache);
  }
  let columns = cache.get(table);
  if (!columns) {
    columns = rows<{ name: string }>(
      db.prepare(`PRAGMA table_info(${table})`).all(),
    ).map((column) => column.name);
    cache.set(table, columns);
  }
  return columns;
}

/**
 * Create one before-image table and one listed view per lagged table.
 * The listed view shows the earliest waiting before-image of a row, or the live row.
 */
export function createLagSchema(db: DatabaseSync): void {
  for (const table of TABLES) {
    const key = LAGGED[table];
    const prior = `${table}_prior`;
    const columns = columnsOf(db, table);
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${prior} (seq INTEGER PRIMARY KEY, written_at INTEGER NOT NULL, absent INTEGER NOT NULL, ${columns.join(', ')})`,
    );
    const existing = new Set(
      rows<{ name: string }>(
        db.prepare(`PRAGMA table_info(${prior})`).all(),
      ).map((column) => column.name),
    );
    for (const column of columns)
      if (!existing.has(column))
        db.exec(`ALTER TABLE ${prior} ADD COLUMN ${column}`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${prior}_key ON ${prior} (${key}, seq)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${prior}_written ON ${prior} (written_at)`,
    );
    PRIOR_INDEXES[table].forEach((index, n) =>
      db.exec(
        `CREATE INDEX IF NOT EXISTS ${prior}_x${n} ON ${prior} (${index})`,
      ),
    );
    const list = columns.join(', ');
    db.exec(`DROP VIEW IF EXISTS ${table}_listed`);
    db.exec(
      `CREATE VIEW ${table}_listed AS ` +
        `SELECT ${list} FROM ${table} live WHERE NOT EXISTS (SELECT 1 FROM ${prior} p WHERE p.${key} = live.${key}) ` +
        `UNION ALL ` +
        `SELECT ${list} FROM ${prior} p WHERE p.absent = 0 AND p.seq = (SELECT MIN(q.seq) FROM ${prior} q WHERE q.${key} = p.${key})`,
    );
  }
}

/** Save the live row as a before-image, or an absent marker when no row exists. */
export function saveBeforeImage(
  db: DatabaseSync,
  table: LaggedTable,
  keyValue: string,
  writtenAt: number,
  delayMs: number,
): void {
  if (delayMs <= 0) return;
  const key = LAGGED[table];
  const list = columnsOf(db, table).join(', ');
  const saved = db
    .prepare(
      `INSERT INTO ${table}_prior (written_at, absent, ${list}) SELECT ?, 0, ${list} FROM ${table} WHERE ${key} = ?`,
    )
    .run(writtenAt, keyValue);
  if (Number(saved.changes) === 0)
    db.prepare(
      `INSERT INTO ${table}_prior (written_at, absent, ${key}) VALUES (?, 1, ?)`,
    ).run(writtenAt, keyValue);
}

/** Save a before-image of every live row that matches the condition. */
export function saveBeforeImagesWhere(
  db: DatabaseSync,
  table: LaggedTable,
  where: string,
  params: readonly (string | number)[],
  writtenAt: number,
  delayMs: number,
): number {
  if (delayMs <= 0) return 0;
  const list = columnsOf(db, table).join(', ');
  return Number(
    db
      .prepare(
        `INSERT INTO ${table}_prior (written_at, absent, ${list}) SELECT ?, 0, ${list} FROM ${table} WHERE ${where}`,
      )
      .run(writtenAt, ...params).changes,
  );
}

/** Delete the before-images that the delay has passed, then name the relation that lists read. */
export function listedRelation(
  db: DatabaseSync,
  table: LaggedTable,
  now: number,
  delayMs: number,
): string {
  db.prepare(`DELETE FROM ${table}_prior WHERE written_at <= ?`).run(
    now - delayMs,
  );
  return db.prepare(`SELECT 1 FROM ${table}_prior LIMIT 1`).get()
    ? `${table}_listed`
    : table;
}

/** Delete every before-image. Returns the number deleted. */
export function flushLag(db: DatabaseSync): number {
  let total = 0;
  for (const table of TABLES)
    total += Number(db.prepare(`DELETE FROM ${table}_prior`).run().changes);
  return total;
}

/** Count the before-images that still wait for the delay. */
export function pendingLag(
  db: DatabaseSync,
  now: number,
  delayMs: number,
): number {
  let total = 0;
  for (const table of TABLES)
    total += Number(
      row<{ n: number }>(
        db
          .prepare(
            `SELECT count(*) AS n FROM ${table}_prior WHERE written_at > ?`,
          )
          .get(now - delayMs),
      )?.n ?? 0,
    );
  return total;
}
