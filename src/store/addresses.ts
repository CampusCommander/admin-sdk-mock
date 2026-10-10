import type { DatabaseSync } from 'node:sqlite';
import { row } from './sqlite.ts';

/**
 * True when a user's primary email or alias, or a group's email or alias, holds
 * the address. `except` skips the entity that already owns it.
 */
export function addressInUse(
  db: DatabaseSync,
  email: string,
  except: { userId?: string; groupId?: string } = {},
): boolean {
  const user = except.userId ?? '';
  const group = except.groupId ?? '';
  return (
    db
      .prepare(
        'SELECT 1 FROM users WHERE primary_email = ? AND id != ? UNION ALL SELECT 1 FROM user_aliases WHERE alias = ? AND user_id != ? UNION ALL SELECT 1 FROM groups WHERE email = ? AND id != ? UNION ALL SELECT 1 FROM group_aliases WHERE alias = ? AND group_id != ? LIMIT 1',
      )
      .get(email, user, email, user, email, group, email, group) !== undefined
  );
}

/** Whether an address is on one of the customer's own domains, an alias domain, or outside. */
export function domainKind(
  db: DatabaseSync,
  email: string,
): 'own' | 'alias' | 'outside' {
  const name = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const found = row<{ alias_of: string | null }>(
    db.prepare('SELECT alias_of FROM domains WHERE domain_name = ?').get(name),
  );
  if (!found) return 'outside';
  return found.alias_of === null ? 'own' : 'alias';
}
