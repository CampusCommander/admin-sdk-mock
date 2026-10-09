import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { rows } from '../store/sqlite.ts';

/** Hash every row of every table in insertion order. */
export function hashDatabase(db: DatabaseSync): string {
  const hash = createHash('sha256');
  const tables = rows<{ name: string }>(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all(),
  );
  for (const { name } of tables) {
    hash.update(name);
    for (const value of db
      .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
      .iterate())
      hash.update(JSON.stringify(value));
  }
  return hash.digest('hex');
}
