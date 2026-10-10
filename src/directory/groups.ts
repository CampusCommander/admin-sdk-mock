import type { DatabaseSync } from 'node:sqlite';
import { ApiError, notAuthorized } from '../http/errors.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import type { GroupRow } from '../store/group-lookup.ts';
import { listedSelect } from '../store/lag.ts';
import {
  decodePageToken,
  encodePageToken,
  fingerprint,
} from '../store/page-token.ts';
import { emptyFilter } from '../store/sql.ts';
import { row, rows } from '../store/sqlite.ts';
import {
  domainOf,
  enumParam,
  intParam,
  invalidArgument,
  listedTable,
  resolveCustomer,
  withEtag,
} from './common.ts';
import { QueryError } from './device-query.ts';
import { resolveMemberTarget, visibleGroup } from './group-common.ts';
import { parseGroupQuery } from './group-query.ts';

const SORT_ORDER = { ascending: 'ASC', descending: 'DESC' } as const;
const ORDER_BY = { email: 'email' } as const;

/** Render a group with its aliases in order and its direct member count. */
export function groupResource(
  group: GroupRow,
  aliases: readonly string[],
  count: number,
): Record<string, unknown> {
  return withEtag({
    kind: 'admin#directory#group',
    id: group.id,
    email: group.email,
    name: group.name,
    description: group.description,
    directMembersCount: String(count),
    adminCreated: group.admin_created === 1,
    ...(aliases.length > 0 ? { aliases: [...aliases] } : {}),
  });
}

/** Direct member counts and aliases of several groups, read from the named relations. */
export function groupDetails(
  db: DatabaseSync,
  ids: readonly string[],
  memberTable = 'group_members',
  aliasTable = 'group_aliases',
): { counts: Map<string, number>; aliases: Map<string, string[]> } {
  const counts = new Map<string, number>();
  const aliases = new Map<string, string[]>();
  if (ids.length === 0) return { counts, aliases };
  const marks = ids.map(() => '?').join(', ');
  for (const entry of rows<{ group_id: string; n: number }>(
    db
      .prepare(
        `SELECT group_id, count(*) AS n FROM ${memberTable} WHERE group_id IN (${marks}) GROUP BY group_id`,
      )
      .all(...ids),
  ))
    counts.set(entry.group_id, Number(entry.n));
  for (const entry of rows<{ alias: string; group_id: string }>(
    db
      .prepare(
        `SELECT alias, group_id FROM ${aliasTable} WHERE group_id IN (${marks}) ORDER BY alias`,
      )
      .all(...ids),
  ))
    aliases.set(entry.group_id, [
      ...(aliases.get(entry.group_id) ?? []),
      entry.alias,
    ]);
  return { counts, aliases };
}

export function getGroup(call: Call): ApiResponse {
  const domain = domainOf(call);
  const group = visibleGroup(call, call.params.groupKey);
  const details = groupDetails(domain.db, [group.id]);
  return {
    status: 200,
    items: 1,
    body: groupResource(
      group,
      details.aliases.get(group.id) ?? [],
      details.counts.get(group.id) ?? 0,
    ),
  };
}

/** `groups.list`. Lists lag writes by the search delay. */
export function listGroups(call: Call): ApiResponse {
  const domain = domainOf(call);
  const query = call.request.query;
  const customer = query.get('customer');
  const domainName = query.get('domain')?.toLowerCase();
  const userKey = query.get('userKey');
  if ((!customer && !domainName && !userKey) || (customer && userKey))
    throw invalidArgument(call, 'Bad Request', 'badRequest');
  const table = listedTable(call, 'groups');
  const members = listedTable(call, 'group_members');
  const aliasTable = listedTable(call, 'group_aliases');
  const filter = emptyFilter();
  if (customer) resolveCustomer(call, customer);
  if (domainName) {
    const known = row(
      domain.db
        .prepare(
          'SELECT 1 FROM domains WHERE domain_name = ? AND alias_of IS NULL',
        )
        .get(domainName),
    );
    if (!known) throw new ApiError(notAuthorized('directory'));
    filter.where.push('substr(email, ?) = ?');
    filter.params.push(-(domainName.length + 1), `@${domainName}`);
  }
  const directMember = (target: { email: string; id: string }) => {
    filter.where.push(
      `id IN (SELECT group_id FROM ${members} WHERE email = ? AND member_id = ?)`,
    );
    filter.params.push(target.email, target.id);
  };
  if (userKey) {
    // Ruling: a userKey that names no user or group of the customer returns 400.
    const target = resolveMemberTarget(call, userKey);
    if (!target || (target.type !== 'USER' && target.type !== 'GROUP'))
      throw invalidArgument(call, 'Invalid Input: userKey');
    directMember(target);
  }
  const maxResults = intParam(call, 'maxResults', {
    fallback: 200,
    min: 1,
    max: 200,
  });
  enumParam(call, 'orderBy', ORDER_BY, 'email');
  const descending = enumParam(call, 'sortOrder', SORT_ORDER, 'ASC') === 'DESC';
  const text = query.get('query');
  if (text) {
    let parsed: ReturnType<typeof parseGroupQuery>;
    try {
      parsed = parseGroupQuery(text);
    } catch (error) {
      if (error instanceof QueryError)
        throw invalidArgument(call, `Invalid Input: ${error.message}`);
      throw error;
    }
    filter.where.push(...parsed.filter.where);
    filter.params.push(...parsed.filter.params);
    if (parsed.memberKey !== null) {
      // Ruling: a memberKey that names nothing returns no groups.
      const target = resolveMemberTarget(call, parsed.memberKey);
      if (target) directMember(target);
      else filter.where.push('0 = 1');
    }
  }
  const hidden = [...call.overrides.hidden(domain.customerId)];
  if (hidden.length > 0) {
    const marks = hidden.map(() => '?').join(', ');
    filter.where.push(`id NOT IN (${marks}) AND email NOT IN (${marks})`);
    filter.params.push(...hidden, ...hidden);
  }
  const fp = fingerprint(call.request.path, query, domain.record.seededAt);
  const pageToken = query.get('pageToken');
  if (pageToken) {
    let cursor: (string | number)[];
    try {
      cursor = decodePageToken(pageToken, fp, 2);
    } catch {
      throw invalidArgument(call, 'Invalid Input: pageToken');
    }
    filter.where.push(`(email, id) ${descending ? '<' : '>'} (?, ?)`);
    filter.params.push(cursor[0], cursor[1]);
  }
  const direction = descending ? 'DESC' : 'ASC';
  const built = listedSelect(domain.db, 'groups', table, {
    extra: 'email AS sort_key',
    where: filter.where,
    params: filter.params,
    tail: `ORDER BY sort_key ${direction}, id ${direction} LIMIT ?`,
  });
  const found = rows<GroupRow & { sort_key: string }>(
    domain.db.prepare(built.sql).all(...built.params, maxResults + 1),
  );
  const page = found.slice(0, maxResults);
  const details = groupDetails(
    domain.db,
    page.map((group) => group.id),
    members,
    aliasTable,
  );
  const last = page.at(-1);
  const nextPageToken =
    found.length > maxResults && last
      ? encodePageToken(fp, [last.email, last.id])
      : undefined;
  const groups = page.map((group) =>
    groupResource(
      group,
      details.aliases.get(group.id) ?? [],
      details.counts.get(group.id) ?? 0,
    ),
  );
  const total = text
    ? Number(
        row<{ n: number }>(
          domain.db.prepare('SELECT count(*) AS n FROM groups').get(),
        )?.n,
      )
    : 0;
  return {
    status: 200,
    items: page.length,
    scanned: total,
    body: withEtag({
      kind: 'admin#directory#groups',
      ...(groups.length > 0 ? { groups } : {}),
      ...(nextPageToken ? { nextPageToken } : {}),
    }),
  };
}
