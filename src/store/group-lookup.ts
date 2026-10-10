import type { DatabaseSync } from 'node:sqlite';
import { createRandom, type Random } from '../random.ts';
import { row } from './sqlite.ts';

export type MemberType = 'USER' | 'GROUP' | 'CUSTOMER';
export type MemberRole = 'OWNER' | 'MANAGER' | 'MEMBER';
export type Delivery = 'ALL_MAIL' | 'DAILY' | 'DIGEST' | 'DISABLED' | 'NONE';

export const ROLES: readonly MemberRole[] = ['OWNER', 'MANAGER', 'MEMBER'];
export const DELIVERIES: readonly Delivery[] = [
  'ALL_MAIL',
  'DAILY',
  'DIGEST',
  'DISABLED',
  'NONE',
];
/** A lower rank is a higher role. Derived membership keeps the lowest rank. */
export const ROLE_RANK: Readonly<Record<MemberRole, number>> = {
  OWNER: 0,
  MANAGER: 1,
  MEMBER: 2,
};

/** One row of the `groups` table. */
export interface GroupRow {
  id: string;
  email: string;
  name: string;
  description: string;
  admin_created: number;
  created_at: number;
}

/** One row of the `group_members` table: one direct membership. */
export interface MemberRow {
  id: number;
  group_id: string;
  member_id: string;
  email: string;
  type: MemberType;
  role: MemberRole;
  delivery: Delivery;
  added_at: number;
}

/** Find a group by email, alias, or ID. Emails match without case. */
export function findGroup(db: DatabaseSync, key: string): GroupRow | undefined {
  const lower = key.toLowerCase();
  return (
    row<GroupRow>(
      db.prepare('SELECT * FROM groups WHERE email = ?').get(lower),
    ) ??
    row<GroupRow>(
      db
        .prepare(
          'SELECT g.* FROM group_aliases a JOIN groups g ON g.id = a.group_id WHERE a.alias = ?',
        )
        .get(lower),
    ) ??
    row<GroupRow>(db.prepare('SELECT * FROM groups WHERE id = ?').get(key))
  );
}

/** Ruling: an outside member has a stable 21-digit ID derived from its address. */
export function outsideMemberId(email: string): string {
  return `1${createRandom(`outside/${email.toLowerCase()}`).string(20, '0123456789')}`;
}

/** Ruling: a group ID is `0` followed by 14 lower-case letters and digits. */
export function newGroupId(
  random: Random,
  taken: (id: string) => boolean,
): string {
  for (;;) {
    const id = `0${random.string(14)}`;
    if (!taken(id)) return id;
  }
}

/**
 * The next `group_members` ID: one past every live row and every waiting
 * before-image, so a new membership never shares a key with a waiting image.
 */
export function nextMemberId(db: DatabaseSync): number {
  return Number(
    row<{ n: number }>(
      db
        .prepare(
          'SELECT MAX(COALESCE((SELECT MAX(id) FROM group_members), 0), COALESCE((SELECT MAX(id) FROM group_members_prior), 0)) + 1 AS n',
        )
        .get(),
    )!.n,
  );
}
