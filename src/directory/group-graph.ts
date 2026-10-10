import type { DatabaseSync } from 'node:sqlite';
import { row, rows } from '../store/sqlite.ts';

/**
 * Every group reached from `groupId`, including `groupId`, through group links
 * added at or before `followableAt`. `table` is `group_members` or its listed view.
 * Groups whose ID or email is in `excluded` are never entered. UNION, not UNION ALL, keeps the walk finite even if a cycle ever existed.
 */
export function reachedGroups(
  db: DatabaseSync,
  table: string,
  groupId: string,
  followableAt: number,
  excluded: readonly string[] = [],
): string[] {
  return rows<{ id: string }>(
    db
      .prepare(
        `WITH RECURSIVE reach(id) AS (SELECT ? UNION SELECT m.member_id FROM ${table} m JOIN reach r ON m.group_id = r.id WHERE m.type = 'GROUP' AND m.added_at <= ? AND m.member_id NOT IN (SELECT value FROM json_each(?)) AND m.email NOT IN (SELECT value FROM json_each(?))) SELECT id FROM reach`,
      )
      .all(
        groupId,
        followableAt,
        JSON.stringify(excluded),
        JSON.stringify(excluded),
      ),
  ).map((entry) => entry.id);
}

/**
 * True when any membership before-image touches a group in `reachJson`, a JSON
 * array of group IDs. Absent markers carry no group, so they match through
 * their live row. Call it after `listedRelation` has purged expired images, so
 * every remaining image waits.
 */
export function lagTouchesGroups(db: DatabaseSync, reachJson: string): boolean {
  return (
    row(
      db
        .prepare(
          'SELECT 1 FROM group_members_prior p LEFT JOIN group_members m ON m.id = p.id WHERE COALESCE(p.group_id, m.group_id) IN (SELECT value FROM json_each(?)) LIMIT 1',
        )
        .get(reachJson),
    ) !== undefined
  );
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
