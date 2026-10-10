import type { ApiResponse, Call } from '../http/types.ts';
import { row } from '../store/sqlite.ts';
import { domainOf, invalidArgument, notFound } from './common.ts';
import {
  nestingDelayMs,
  resolveMemberTarget,
  visibleGroup,
} from './group-common.ts';
import { reachedGroups } from './group-graph.ts';

const domainPart = (email: string) => email.slice(email.lastIndexOf('@') + 1);
const IN_REACH = 'group_id IN (SELECT value FROM json_each(?))';

/**
 * `members.hasMember`. Direct membership answers on any domain. A nested check
 * needs the user and the group on one email domain, as Google documents.
 */
export function hasMember(call: Call): ApiResponse {
  const db = domainOf(call).db;
  const group = visibleGroup(call, call.params.groupKey);
  const target = resolveMemberTarget(call, call.params.memberKey);
  // Ruling: an unknown key answers 404. Groups, outside addresses, and the customer answer 400.
  if (!target) throw notFound('memberKey');
  if (target.type !== 'USER')
    throw invalidArgument(call, 'Invalid Input: memberKey');
  const direct = row(
    db
      .prepare(
        'SELECT 1 FROM group_members WHERE group_id = ? AND email = ? AND member_id = ?',
      )
      .get(group.id, target.email, target.id),
  );
  if (direct) return { status: 200, items: 1, body: { isMember: true } };
  if (domainPart(target.email) !== domainPart(group.email))
    throw invalidArgument(call, 'Invalid Input');
  const reach = JSON.stringify(
    reachedGroups(
      db,
      'group_members',
      group.id,
      call.now - nestingDelayMs(call),
    ),
  );
  const found =
    row(
      db
        .prepare(
          `SELECT 1 FROM group_members WHERE email = ? AND member_id = ? AND ${IN_REACH} LIMIT 1`,
        )
        .get(target.email, target.id, reach),
    ) ??
    row(
      db
        .prepare(
          `SELECT 1 FROM group_members WHERE email = '' AND type = 'CUSTOMER' AND ${IN_REACH} LIMIT 1`,
        )
        .get(reach),
    );
  return { status: 200, items: 1, body: { isMember: found !== undefined } };
}
