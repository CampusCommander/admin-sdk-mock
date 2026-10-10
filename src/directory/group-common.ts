import type { Call } from '../http/types.ts';
import { domainKind } from '../store/addresses.ts';
import {
  findGroup,
  outsideMemberId,
  type GroupRow,
} from '../store/group-lookup.ts';
import { findUser, type UserRow } from '../store/user-lookup.ts';
import { domainOf, notFound } from './common.ts';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Find a group that requests may see by email, alias, or ID. Unknown and hidden groups answer 404. */
export function visibleGroup(call: Call, key: string): GroupRow {
  const domain = domainOf(call);
  const group = findGroup(domain.db, key);
  const hidden = call.overrides.hidden(domain.customerId);
  if (!group || hidden.has(group.id) || hidden.has(group.email))
    throw notFound('groupKey');
  return group;
}

/** What a member key names. `OUTSIDE` is an address on a domain outside the customer. */
export type MemberTarget =
  | { type: 'USER'; id: string; email: string; user: UserRow }
  | { type: 'GROUP'; id: string; email: string; group: GroupRow }
  | { type: 'CUSTOMER'; id: string; email: '' }
  | { type: 'OUTSIDE'; id: string; email: string };

/** Resolve a member key. Unknown keys, and hidden users and groups, resolve to undefined. */
export function resolveMemberTarget(
  call: Call,
  key: string,
): MemberTarget | undefined {
  const domain = domainOf(call);
  const hidden = call.overrides.hidden(domain.customerId);
  const user = findUser(domain.db, key);
  if (user && !hidden.has(user.id) && !hidden.has(user.primary_email))
    return { type: 'USER', id: user.id, email: user.primary_email, user };
  const group = findGroup(domain.db, key);
  if (group && !hidden.has(group.id) && !hidden.has(group.email))
    return { type: 'GROUP', id: group.id, email: group.email, group };
  if (key === domain.customerId)
    return { type: 'CUSTOMER', id: domain.customerId, email: '' };
  if (EMAIL.test(key) && domainKind(domain.db, key) === 'outside') {
    const email = key.toLowerCase();
    return { type: 'OUTSIDE', id: outsideMemberId(email), email };
  }
  return undefined;
}

/** The nesting delay of the call's domain in scaled milliseconds. */
export function nestingDelayMs(call: Call): number {
  return (
    (domainOf(call).record.settings.writes.nestingDelaySeconds * 1000) /
    call.scale
  );
}

/** The ready delay of the call's domain in scaled milliseconds. */
export function groupReadyMs(call: Call): number {
  return (
    (domainOf(call).record.settings.writes.groupReadySeconds * 1000) /
    call.scale
  );
}
