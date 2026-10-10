import { ApiError, directoryError } from '../http/errors.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import {
  DELIVERIES,
  ROLES,
  nextMemberId,
  type MemberRow,
  type MemberType,
} from '../store/group-lookup.ts';
import { saveBeforeImage } from '../store/lag.ts';
import { row, transaction } from '../store/sqlite.ts';
import {
  domainOf,
  invalidArgument,
  jsonBody,
  notFound,
  searchDelayMs,
} from './common.ts';
import {
  groupReadyMs,
  resolveMemberTarget,
  visibleGroup,
} from './group-common.ts';
import { reaches } from './group-graph.ts';
import { directMember, liveMember } from './members.ts';

/** Ruling: a duplicate membership answers 409 with this message. */
const memberExists = () =>
  new ApiError(directoryError(409, 'duplicate', 'Member already exists.'));

/** Read an optional enum field. Null or absent reads as undefined. */
function enumField<T extends string>(
  call: Call,
  body: Record<string, unknown>,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    !(values as readonly string[]).includes(value)
  )
    throw invalidArgument(call, `Invalid Input: ${name}`);
  return value as T;
}

const memberById = (call: Call, id: number) =>
  row<MemberRow>(
    domainOf(call)
      .db.prepare('SELECT * FROM group_members WHERE id = ?')
      .get(id),
  )!;

/** `members.insert`. The type follows the key: user, group, customer, or outside address. */
export function insertMember(call: Call): ApiResponse {
  const domain = domainOf(call);
  const db = domain.db;
  const group = visibleGroup(call, call.params.groupKey);
  // Ruling: inserting into a group younger than the ready delay answers 404.
  if (call.now - group.created_at < groupReadyMs(call))
    throw notFound('groupKey');
  const body = jsonBody(call);
  const key =
    typeof body.email === 'string' && body.email !== ''
      ? body.email
      : typeof body.id === 'string' && body.id !== ''
        ? body.id
        : undefined;
  if (key === undefined)
    throw invalidArgument(call, 'Invalid Input: memberKey');
  const role = enumField(call, body, 'role', ROLES) ?? 'MEMBER';
  const delivery =
    enumField(call, body, 'delivery_settings', DELIVERIES) ?? 'ALL_MAIL';
  // Ruling: an address on a customer domain that names nothing answers 404.
  const target = resolveMemberTarget(call, key);
  if (!target) throw notFound('memberKey');
  const type: MemberType =
    target.type === 'GROUP'
      ? 'GROUP'
      : target.type === 'CUSTOMER'
        ? 'CUSTOMER'
        : 'USER';
  if (
    row(
      db
        .prepare(
          'SELECT 1 FROM group_members WHERE group_id = ? AND email = ? AND member_id = ?',
        )
        .get(group.id, target.email, target.id),
    )
  )
    throw memberExists();
  // Ruling: a cycle answers 400. The check follows links still inside the nesting delay.
  if (type === 'GROUP' && reaches(db, target.id, group.id))
    throw invalidArgument(call, 'Cyclic memberships not allowed.');
  // A new ID past every live row and every waiting before-image never reuses a key.
  const id = nextMemberId(db);
  transaction(db, () => {
    saveBeforeImage(db, 'group_members', id, call.now, searchDelayMs(call));
    db.prepare(
      'INSERT INTO group_members (id, group_id, member_id, email, type, role, delivery, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      group.id,
      target.id,
      target.email,
      type,
      role,
      delivery,
      call.now,
    );
  });
  return { status: 200, body: liveMember(db, memberById(call, id)) };
}

/** `members.update` and `members.patch`. Both change only `role` and `delivery_settings`. */
export function updateMember(call: Call): ApiResponse {
  const db = domainOf(call).db;
  const group = visibleGroup(call, call.params.groupKey);
  const member = directMember(call, group, call.params.memberKey);
  const body = jsonBody(call);
  const role = enumField(call, body, 'role', ROLES);
  const delivery = enumField(call, body, 'delivery_settings', DELIVERIES);
  if (role !== undefined || delivery !== undefined)
    transaction(db, () => {
      saveBeforeImage(
        db,
        'group_members',
        member.id,
        call.now,
        searchDelayMs(call),
      );
      db.prepare(
        'UPDATE group_members SET role = ?, delivery = ? WHERE id = ?',
      ).run(role ?? member.role, delivery ?? member.delivery, member.id);
    });
  return { status: 200, body: liveMember(db, memberById(call, member.id)) };
}

/** `members.delete`. Removes one direct membership. */
export function deleteMember(call: Call): ApiResponse {
  const db = domainOf(call).db;
  const group = visibleGroup(call, call.params.groupKey);
  const member = directMember(call, group, call.params.memberKey);
  transaction(db, () => {
    saveBeforeImage(
      db,
      'group_members',
      member.id,
      call.now,
      searchDelayMs(call),
    );
    db.prepare('DELETE FROM group_members WHERE id = ?').run(member.id);
  });
  return { status: 204, scanned: 1 };
}
