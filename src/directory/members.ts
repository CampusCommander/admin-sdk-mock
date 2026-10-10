import type { DatabaseSync } from 'node:sqlite';
import type { ApiResponse, Call } from '../http/types.ts';
import {
  ROLE_RANK,
  ROLES,
  type GroupRow,
  type MemberRole,
  type MemberRow,
} from '../store/group-lookup.ts';
import { listedSelect } from '../store/lag.ts';
import {
  decodePageToken,
  encodePageToken,
  fingerprint,
} from '../store/page-token.ts';
import { row, rows } from '../store/sqlite.ts';
import {
  boolParam,
  domainOf,
  intParam,
  invalidArgument,
  listedTable,
  notFound,
  withEtag,
} from './common.ts';
import {
  nestingDelayMs,
  resolveMemberTarget,
  visibleGroup,
} from './group-common.ts';
import { lagTouchesGroups, reachedGroups } from './group-graph.ts';

/** Derived pages scan the email index once the reached groups hold more rows than this. */
export const EMAIL_SCAN_ROWS = 5000;

type Listed = Pick<MemberRow, 'member_id' | 'email' | 'type' | 'role'> & {
  delivery?: string;
};

/** Render one membership. List entries omit `delivery_settings`, as Google documents. */
export function memberResource(
  member: Listed,
  suspended: boolean,
  withDelivery: boolean,
): Record<string, unknown> {
  return withEtag({
    kind: 'admin#directory#member',
    id: member.member_id,
    ...(member.type === 'CUSTOMER' ? {} : { email: member.email }),
    role: member.role,
    type: member.type,
    // Ruling: SUSPENDED for a suspended user, ACTIVE for every other member.
    status: suspended ? 'SUSPENDED' : 'ACTIVE',
    ...(withDelivery && member.delivery
      ? { delivery_settings: member.delivery }
      : {}),
  });
}

/** The IDs among `ids` that are suspended users in the named users relation. */
export function suspendedUsers(
  db: DatabaseSync,
  table: string,
  ids: readonly string[],
): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set(
    rows<{ id: string }>(
      db
        .prepare(
          `SELECT id FROM ${table} WHERE suspended = 1 AND id IN (${ids.map(() => '?').join(', ')})`,
        )
        .all(...ids),
    ).map((entry) => entry.id),
  );
}

/** Render a membership from the live tables, with its delivery setting. */
export function liveMember(
  db: DatabaseSync,
  member: MemberRow,
): Record<string, unknown> {
  const suspended =
    member.type === 'USER' &&
    suspendedUsers(db, 'users', [member.member_id]).size > 0;
  return memberResource(member, suspended, true);
}

/** Find a direct membership by member key. Ruling: a nested member answers 404. */
export function directMember(
  call: Call,
  group: GroupRow,
  key: string,
): MemberRow {
  const db = domainOf(call).db;
  const target = resolveMemberTarget(call, key);
  const found = target
    ? row<MemberRow>(
        db
          .prepare(
            'SELECT * FROM group_members WHERE group_id = ? AND email = ? AND member_id = ?',
          )
          .get(group.id, target.email, target.id),
      )
    : row<MemberRow>(
        db
          .prepare(
            'SELECT * FROM group_members WHERE group_id = ? AND member_id = ?',
          )
          .get(group.id, key),
      );
  const hidden = call.overrides.hidden(domainOf(call).customerId);
  if (!found || hidden.has(found.member_id) || hidden.has(found.email))
    throw notFound('memberKey');
  return found;
}

function rolesParam(call: Call): MemberRole[] | null {
  const raw = call.request.query.get('roles');
  if (raw === null || raw === '') return null;
  const roles = raw.split(',').map((role) => role.trim());
  if (!roles.every((role) => (ROLES as readonly string[]).includes(role)))
    throw invalidArgument(call, 'Invalid Input: roles');
  return roles as MemberRole[];
}

/**
 * The derived-membership page query. Parameters, in order: the reached group IDs
 * as a JSON array, the cursor email and member ID when `cursor` is set, the hidden
 * entries twice (once for member_id, once for email), one rank per role filter,
 * and the row limit. On the live table, large sets scan the
 * `(email, member_id)` index in order, so GROUP BY and ORDER BY need no sort.
 */
export function derivedQuery(
  table: string,
  total: number,
  options: { cursor: boolean; roles: number; hidden?: number },
): string {
  const hint =
    table !== 'group_members'
      ? ''
      : total > EMAIL_SCAN_ROWS
        ? ' INDEXED BY group_members_email'
        : ' INDEXED BY group_members_order';
  const marks = Array(options.hidden ?? 0)
    .fill('?')
    .join(', ');
  const hidden = options.hidden
    ? ` AND member_id NOT IN (${marks}) AND email NOT IN (${marks})`
    : '';
  const having =
    options.roles > 0
      ? ` HAVING rank IN (${Array(options.roles).fill('?').join(', ')})`
      : '';
  return (
    `SELECT member_id, email, type, MIN(CASE role WHEN 'OWNER' THEN 0 WHEN 'MANAGER' THEN 1 ELSE 2 END) AS rank ` +
    `FROM ${table}${hint} WHERE group_id IN (SELECT value FROM json_each(?))` +
    (options.cursor ? ' AND (email, member_id) > (?, ?)' : '') +
    hidden +
    ` GROUP BY email, member_id${having} ORDER BY email, member_id LIMIT ?`
  );
}

/** `members.list`. Lists lag writes. Derived lists also wait for the nesting delay. */
export function listMembers(call: Call): ApiResponse {
  const domain = domainOf(call);
  const db = domain.db;
  const query = call.request.query;
  const group = visibleGroup(call, call.params.groupKey);
  const maxResults = intParam(call, 'maxResults', {
    fallback: 200,
    min: 1,
    max: 200,
  });
  const roles = rolesParam(call);
  const derived = boolParam(call, 'includeDerivedMembership');
  const table = listedTable(call, 'group_members');
  const users = listedTable(call, 'users');
  const hidden = [...call.overrides.hidden(domain.customerId)];
  const fp = fingerprint(call.request.path, query, domain.record.seededAt);
  const pageToken = query.get('pageToken');
  let cursor: (string | number)[] | null = null;
  if (pageToken) {
    try {
      cursor = decodePageToken(pageToken, fp, 2);
    } catch {
      throw invalidArgument(call, 'Invalid Input: pageToken');
    }
  }
  let found: Listed[];
  let scanned = 0;
  if (derived) {
    const reach = JSON.stringify(
      reachedGroups(
        db,
        table,
        group.id,
        call.now - nestingDelayMs(call),
        hidden,
      ),
    );
    // Ruling: the page reads the live table and its index unless a waiting write
    // touches a reached group. Untouched groups hold the same rows in both relations.
    const source =
      table !== 'group_members' && lagTouchesGroups(db, reach)
        ? table
        : 'group_members';
    scanned = Number(
      row<{ n: number }>(
        db
          .prepare(
            `SELECT count(*) AS n FROM ${source} WHERE group_id IN (SELECT value FROM json_each(?))`,
          )
          .get(reach),
      )?.n ?? 0,
    );
    found = rows<{
      member_id: string;
      email: string;
      type: Listed['type'];
      rank: number;
    }>(
      db
        .prepare(
          derivedQuery(source, scanned, {
            cursor: cursor !== null,
            roles: roles?.length ?? 0,
            hidden: hidden.length,
          }),
        )
        .all(
          reach,
          ...(cursor ?? []),
          ...hidden,
          ...hidden,
          ...(roles ?? []).map((role) => ROLE_RANK[role]),
          maxResults + 1,
        ),
    ).map((entry) => ({ ...entry, role: ROLES[entry.rank] }));
  } else {
    const where = ['group_id = ?'];
    const params: (string | number)[] = [group.id];
    if (roles) {
      where.push(`role IN (${roles.map(() => '?').join(', ')})`);
      params.push(...roles);
    }
    if (cursor) {
      where.push('(email, member_id) > (?, ?)');
      params.push(cursor[0], cursor[1]);
    }
    if (hidden.length > 0) {
      const marks = hidden.map(() => '?').join(', ');
      where.push(`member_id NOT IN (${marks})`, `email NOT IN (${marks})`);
      params.push(...hidden, ...hidden);
    }
    const built = listedSelect(db, 'group_members', table, {
      extra: 'email AS sort_key',
      where,
      params,
      tail: 'ORDER BY sort_key, member_id LIMIT ?',
    });
    found = rows<MemberRow>(
      db.prepare(built.sql).all(...built.params, maxResults + 1),
    );
  }
  const page = found.slice(0, maxResults);
  const last = page.at(-1);
  const nextPageToken =
    found.length > maxResults && last
      ? encodePageToken(fp, [last.email, last.member_id])
      : undefined;
  const suspended = suspendedUsers(
    db,
    users,
    page
      .filter((member) => member.type === 'USER')
      .map((member) => member.member_id),
  );
  const members = page.map((member) =>
    memberResource(member, suspended.has(member.member_id), false),
  );
  return {
    status: 200,
    items: page.length,
    scanned,
    body: withEtag({
      kind: 'admin#directory#members',
      ...(members.length > 0 ? { members } : {}),
      ...(nextPageToken ? { nextPageToken } : {}),
    }),
  };
}

export function getMember(call: Call): ApiResponse {
  const domain = domainOf(call);
  const group = visibleGroup(call, call.params.groupKey);
  const member = directMember(call, group, call.params.memberKey);
  return { status: 200, items: 1, body: liveMember(domain.db, member) };
}
