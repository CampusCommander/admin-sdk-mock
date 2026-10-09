import type { DatabaseSync } from 'node:sqlite';
import { row } from './sqlite.ts';

/** One row of the `users` table. */
export interface UserRow {
  id: string;
  primary_email: string;
  given_name: string;
  family_name: string;
  full_name: string;
  org_unit_path: string;
  is_admin: number;
  suspended: number;
  suspension_reason: string | null;
  external_id: string | null;
  role: string;
  school: number | null;
  creation_time: number;
  last_login_time: number | null;
  ord: number;
}

/** Find a user by primary email, alias, or user ID. */
export function findUser(db: DatabaseSync, key: string): UserRow | undefined {
  const lower = key.toLowerCase();
  return (
    row<UserRow>(
      db.prepare('SELECT * FROM users WHERE primary_email = ?').get(lower),
    ) ??
    row<UserRow>(
      db
        .prepare(
          'SELECT u.* FROM user_aliases a JOIN users u ON u.id = a.user_id WHERE a.alias = ?',
        )
        .get(lower),
    ) ??
    row<UserRow>(db.prepare('SELECT * FROM users WHERE id = ?').get(key))
  );
}
