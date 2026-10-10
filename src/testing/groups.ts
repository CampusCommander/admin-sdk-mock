import type { DatabaseSync } from 'node:sqlite';
import { createRandom } from '../random.ts';
import {
  newGroupId,
  type Delivery,
  type GroupRow,
  type MemberRole,
  type MemberType,
} from '../store/group-lookup.ts';
import { row } from '../store/sqlite.ts';

/** Insert one group row directly, for tests. Times default to 0, so no delay applies. */
export function addTestGroup(
  db: DatabaseSync,
  input: {
    email: string;
    id?: string;
    name?: string;
    description?: string;
    adminCreated?: boolean;
    createdAt?: number;
  },
): GroupRow {
  const email = input.email.toLowerCase();
  const id =
    input.id ??
    newGroupId(
      createRandom(`test-group/${email}`),
      (taken) =>
        db.prepare('SELECT 1 FROM groups WHERE id = ?').get(taken) !==
        undefined,
    );
  db.prepare(
    'INSERT INTO groups (id, email, name, description, admin_created, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    email,
    input.name ?? email.slice(0, email.indexOf('@')),
    input.description ?? '',
    input.adminCreated === false ? 0 : 1,
    input.createdAt ?? 0,
  );
  return row<GroupRow>(
    db.prepare('SELECT * FROM groups WHERE id = ?').get(id),
  )!;
}

/** Insert one direct membership row, for tests. Returns its row ID. */
export function addTestMember(
  db: DatabaseSync,
  input: {
    groupId: string;
    memberId: string;
    email: string;
    type?: MemberType;
    role?: MemberRole;
    delivery?: Delivery;
    addedAt?: number;
  },
): number {
  return Number(
    db
      .prepare(
        'INSERT INTO group_members (group_id, member_id, email, type, role, delivery, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.groupId,
        input.memberId,
        input.email.toLowerCase(),
        input.type ?? 'USER',
        input.role ?? 'MEMBER',
        input.delivery ?? 'ALL_MAIL',
        input.addedAt ?? 0,
      ).lastInsertRowid,
  );
}
