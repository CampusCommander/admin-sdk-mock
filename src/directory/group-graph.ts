import type { DatabaseSync } from 'node:sqlite';
import { row, rows } from '../store/sqlite.ts';

/**
 * Every group reached from `groupId`, including `groupId`, through group links
 * added at or before `followableAt`. `table` is `group_members` or its listed view.
 * UNION, not UNION ALL, keeps the walk finite even if a cycle ever existed.
 */
export function reachedGroups(
  db: DatabaseSync,
  table: string,
  groupId: string,
  followableAt: number,
): string[] {
  return rows<{ id: string }>(
    db
      .prepare(
        `WITH RECURSIVE reach(id) AS (SELECT ? UNION SELECT m.member_id FROM ${table} m JOIN reach r ON m.group_id = r.id WHERE m.type = 'GROUP' AND m.added_at <= ?) SELECT id FROM reach`,
      )
      .all(groupId, followableAt),
  ).map((entry) => entry.id);
}

/** True when `to` is `from` or lies below it through any live group link. Cycle checks use this. */
export function reaches(db: DatabaseSync, from: string, to: string): boolean {
  return (
    row(
      db
        .prepare(
          "WITH RECURSIVE reach(id) AS (SELECT ? UNION SELECT m.member_id FROM group_members m JOIN reach r ON m.group_id = r.id WHERE m.type = 'GROUP') SELECT 1 FROM reach WHERE id = ? LIMIT 1",
        )
        .get(from, to),
    ) !== undefined
  );
}
