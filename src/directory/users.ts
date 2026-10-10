import type { DatabaseSync } from 'node:sqlite';
import { ApiError, notAuthorized } from '../http/errors.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import {
  decodePageToken,
  encodePageToken,
  fingerprint,
} from '../store/page-token.ts';
import { emptyFilter, whereClause } from '../store/sql.ts';
import { row, rows } from '../store/sqlite.ts';
import { findUser, type UserRow } from '../store/user-lookup.ts';
import {
  boolParam,
  domainOf,
  enumParam,
  intParam,
  invalidArgument,
  iso,
  listedTable,
  notFound,
  resolveCustomer,
  undeleteWindowMs,
  withEtag,
} from './common.ts';
import { QueryError } from './device-query.ts';
import { parseUserQuery } from './user-query.ts';

type View = 'admin_view' | 'domain_public';
const VIEW = {
  adminview: 'admin_view',
  domainpublic: 'domain_public',
} as const;
const PROJECTION = { basic: 'basic', full: 'full', custom: 'custom' } as const;
const SORT_ORDER = { ascending: 'ASC', descending: 'DESC' } as const;
const SORT = {
  email: 'primary_email',
  familyName: 'family_name',
  givenName: 'given_name',
} as const;
const ORDER_BY: Readonly<Record<string, keyof typeof SORT>> = {
  email: 'email',
  familyname: 'familyName',
  givenname: 'givenName',
};
const NEVER = '1970-01-01T00:00:00.000Z';
const counts = new WeakMap<DatabaseSync, number>();

function userCount(db: DatabaseSync): number {
  let count = counts.get(db);
  if (count === undefined) {
    count = Number(
      row<{ n: number }>(db.prepare('SELECT count(*) AS n FROM users').get())
        ?.n,
    );
    counts.set(db, count);
  }
  return count;
}

export function userResource(
  user: UserRow,
  view: View,
  aliases: readonly string[],
  customerId: string,
  deletedAt?: number,
): Record<string, unknown> {
  const name = {
    givenName: user.given_name,
    familyName: user.family_name,
    fullName: user.full_name,
  };
  const emails = [
    { address: user.primary_email, primary: true },
    ...aliases.map((address) => ({ address })),
  ];
  if (view === 'domain_public')
    return withEtag({
      kind: 'admin#directory#user',
      id: user.id,
      primaryEmail: user.primary_email,
      name,
      emails,
    });
  return withEtag({
    kind: 'admin#directory#user',
    id: user.id,
    primaryEmail: user.primary_email,
    name,
    isAdmin: user.is_admin === 1,
    isDelegatedAdmin: false,
    lastLoginTime: iso(user.last_login_time) ?? NEVER,
    creationTime: iso(user.creation_time),
    ...(deletedAt !== undefined ? { deletionTime: iso(deletedAt) } : {}),
    agreedToTerms: true,
    suspended: user.suspended === 1,
    ...(user.suspended === 1
      ? { suspensionReason: user.suspension_reason ?? 'ADMIN' }
      : {}),
    archived: false,
    changePasswordAtNextLogin: user.change_password_at_next_login === 1,
    ipWhitelisted: false,
    emails,
    ...(aliases.length > 0 ? { aliases: [...aliases] } : {}),
    ...(user.external_ids
      ? { externalIds: JSON.parse(user.external_ids) as unknown[] }
      : user.external_id
        ? { externalIds: [{ value: user.external_id, type: 'organization' }] }
        : {}),
    customerId,
    orgUnitPath: user.org_unit_path,
    isMailboxSetup: true,
    isEnrolledIn2Sv: false,
    isEnforcedIn2Sv: false,
    includeInGlobalAddressList: true,
  });
}

function aliasesFor(
  db: DatabaseSync,
  ids: readonly string[],
  table = 'user_aliases',
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  for (const { alias, user_id } of rows<{ alias: string; user_id: string }>(
    db
      .prepare(
        `SELECT alias, user_id FROM ${table} WHERE user_id IN (${ids.map(() => '?').join(', ')}) ORDER BY alias`,
      )
      .all(...ids),
  ))
    out.set(user_id, [...(out.get(user_id) ?? []), alias]);
  return out;
}

function viewOf(call: Call): View {
  const view = enumParam<View>(call, 'viewType', VIEW, 'admin_view');
  if (view === 'admin_view' && !call.access?.isAdmin)
    throw new ApiError(notAuthorized('directory'));
  return view;
}

export function listUsers(call: Call): ApiResponse {
  const domain = domainOf(call);
  const query = call.request.query;
  const customer = query.get('customer');
  const domainName = query.get('domain')?.toLowerCase();
  if (!customer && !domainName)
    throw invalidArgument(call, 'Bad Request', 'badRequest');
  const filter = emptyFilter();
  const deleted = boolParam(call, 'showDeleted');
  const table = listedTable(call, deleted ? 'deleted_users' : 'users');
  if (deleted) {
    filter.where.push('deleted_at > ?');
    filter.params.push(call.now - undeleteWindowMs(call));
  }
  const aliasTable = listedTable(call, 'user_aliases');
  if (customer) resolveCustomer(call, customer);
  else {
    const known = row(
      domain.db
        .prepare(
          'SELECT domain_name FROM domains WHERE domain_name = ? AND alias_of IS NULL',
        )
        .get(domainName!),
    );
    if (!known) throw new ApiError(notAuthorized('directory'));
    filter.where.push('substr(primary_email, ?) = ?');
    filter.params.push(-(domainName!.length + 1), `@${domainName}`);
  }
  const view = viewOf(call);
  const maxResults = intParam(call, 'maxResults', {
    fallback: 100,
    min: 1,
    max: 500,
  });
  enumParam(call, 'projection', PROJECTION, 'basic');
  const sort = SORT[enumParam(call, 'orderBy', ORDER_BY, 'email')];
  const descending = enumParam(call, 'sortOrder', SORT_ORDER, 'ASC') === 'DESC';
  const text = query.get('query');
  if (text) {
    try {
      const parsed = parseUserQuery(text, aliasTable);
      filter.where.push(...parsed.where);
      filter.params.push(...parsed.params);
    } catch (error) {
      if (error instanceof QueryError)
        throw invalidArgument(call, `Invalid Input: ${error.message}`);
      throw error;
    }
  }
  const hidden = [...call.overrides.hidden(domain.customerId)];
  if (hidden.length > 0) {
    const marks = hidden.map(() => '?').join(', ');
    filter.where.push(
      `id NOT IN (${marks}) AND primary_email NOT IN (${marks})`,
    );
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
    filter.where.push(`(${sort}, id) ${descending ? '<' : '>'} (?, ?)`);
    filter.params.push(cursor[0], cursor[1]);
  }
  const direction = descending ? 'DESC' : 'ASC';
  const found = rows<
    UserRow & { sort_key: string; deleted_at?: number; aliases?: string }
  >(
    domain.db
      .prepare(
        `SELECT *, ${sort} AS sort_key FROM ${table} ${whereClause(filter)} ORDER BY ${sort} ${direction}, id ${direction} LIMIT ?`,
      )
      .all(...filter.params, maxResults + 1),
  );
  const page = found.slice(0, maxResults);
  const aliases = deleted
    ? new Map(
        page.map((user) => [
          user.id,
          JSON.parse(user.aliases ?? '[]') as string[],
        ]),
      )
    : aliasesFor(
        domain.db,
        page.map((user) => user.id),
        aliasTable,
      );
  const last = page.at(-1);
  const nextPageToken =
    found.length > maxResults && last
      ? encodePageToken(fp, [last.sort_key, last.id])
      : undefined;
  const users = page.map((user) =>
    userResource(
      user,
      view,
      aliases.get(user.id) ?? [],
      domain.customerId,
      deleted ? user.deleted_at : undefined,
    ),
  );
  return {
    status: 200,
    items: page.length,
    scanned: text ? userCount(domain.db) : 0,
    body: withEtag({
      kind: 'admin#directory#users',
      ...(users.length > 0 ? { users } : {}),
      ...(nextPageToken ? { nextPageToken } : {}),
    }),
  };
}

/** Find a user that requests may see by email, alias, or ID. Unknown and hidden users answer 404. */
export function visibleUser(call: Call, key: string): UserRow {
  const domain = domainOf(call);
  const user = findUser(domain.db, key);
  const hidden = call.overrides.hidden(domain.customerId);
  if (!user || hidden.has(user.id) || hidden.has(user.primary_email))
    throw notFound('userKey');
  return user;
}

export function getUser(call: Call): ApiResponse {
  const domain = domainOf(call);
  const view = viewOf(call);
  const user = visibleUser(call, call.params.userKey);
  return {
    status: 200,
    items: 1,
    body: userResource(
      user,
      view,
      aliasesFor(domain.db, [user.id]).get(user.id) ?? [],
      domain.customerId,
    ),
  };
}
