import type { DatabaseSync } from 'node:sqlite';
import type { ApiResponse, Call } from '../http/types.ts';
import { createRandom } from '../random.ts';
import { saveBeforeImage } from '../store/lag.ts';
import { row, rows, transaction } from '../store/sqlite.ts';
import type { UserRow } from '../store/user-lookup.ts';
import {
  booleanField,
  domainOf,
  duplicate,
  invalidArgument,
  jsonBody,
  searchDelayMs,
  stringField,
} from './common.ts';
import { resolveOrgUnit, targetOrgUnit } from './orgunits.ts';
import { userResource } from './users.ts';

const MAX_NAME = 60;
const HASH_FUNCTIONS: ReadonlySet<string> = new Set(['MD5', 'SHA-1', 'crypt']);
const EMAIL = /^[^@\s]+@[^@\s]+$/;

/** Read a primary email on one of the customer's own domains. Alias domains do not count. */
export function primaryEmail(call: Call, value: unknown): string {
  if (typeof value !== 'string' || !EMAIL.test(value.trim()))
    throw invalidArgument(call, 'Invalid Input: primaryEmail');
  const email = value.trim().toLowerCase();
  const own = row(
    domainOf(call)
      .db.prepare(
        'SELECT 1 FROM domains WHERE domain_name = ? AND alias_of IS NULL',
      )
      .get(email.slice(email.indexOf('@') + 1)),
  );
  if (!own) throw invalidArgument(call, 'Invalid Input: primaryEmail');
  return email;
}

/** True when another user holds the address as a primary email or an alias. */
export function emailInUse(
  db: DatabaseSync,
  email: string,
  exceptUserId = '',
): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM users WHERE primary_email = ? AND id != ? UNION ALL SELECT 1 FROM user_aliases WHERE alias = ? AND user_id != ? LIMIT 1',
      )
      .get(email, exceptUserId, email, exceptUserId) !== undefined
  );
}

function namePart(
  call: Call,
  name: Record<string, unknown>,
  field: string,
): string {
  const value = name[field];
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    [...value].length > MAX_NAME
  )
    throw invalidArgument(call, `Invalid Input: name.${field}`);
  return value.trim();
}

/** Read a `name` object. With `current`, a missing part keeps its current value. */
export function readName(
  call: Call,
  value: unknown,
  current?: { given: string; family: string },
): { given: string; family: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidArgument(call, 'Invalid Input: name');
  const name = value as Record<string, unknown>;
  return {
    given:
      current && name.givenName === undefined
        ? current.given
        : namePart(call, name, 'givenName'),
    family:
      current && name.familyName === undefined
        ? current.family
        : namePart(call, name, 'familyName'),
  };
}

/** Check a password. Google never returns a password, so the mock never stores one. */
export function checkPassword(call: Call, body: Record<string, unknown>): void {
  const { password, hashFunction } = body;
  if (
    hashFunction !== undefined &&
    hashFunction !== null &&
    (typeof hashFunction !== 'string' || !HASH_FUNCTIONS.has(hashFunction))
  )
    throw invalidArgument(call, 'Invalid Input: hashFunction');
  if (typeof password !== 'string' || password === '')
    throw invalidArgument(call, 'Invalid Password');
  const length = [...password].length;
  if (!hashFunction && (length < 8 || length > 100))
    throw invalidArgument(call, 'Invalid Password');
}

/** Read `externalIds`. Null or an empty array clears. The first value stays searchable. */
export function readExternalIds(
  call: Call,
  value: unknown,
): { json: string | null; first: string | null } {
  if (value === null) return { json: null, first: null };
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { value?: unknown }).value === 'string',
    )
  )
    throw invalidArgument(call, 'Invalid Input: externalIds');
  if (value.length === 0) return { json: null, first: null };
  return {
    json: JSON.stringify(value),
    first: (value[0] as { value: string }).value,
  };
}

/** Render a user after a write, with its current aliases. */
export function writtenUser(call: Call, id: string): Record<string, unknown> {
  const domain = domainOf(call);
  const user = row<UserRow>(
    domain.db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  )!;
  const aliases = rows<{ alias: string }>(
    domain.db
      .prepare(
        'SELECT alias FROM user_aliases WHERE user_id = ? ORDER BY alias',
      )
      .all(id),
  ).map((entry) => entry.alias);
  return userResource(user, 'admin_view', aliases, domain.customerId);
}

function newUserId(call: Call, email: string): string {
  const domain = domainOf(call);
  const random = createRandom(`user/${domain.spec.seed}/${email}/${call.now}`);
  const taken = domain.db.prepare(
    'SELECT 1 FROM users WHERE id = ? UNION ALL SELECT 1 FROM deleted_users WHERE id = ?',
  );
  for (;;) {
    const id = `1${random.string(20, '0123456789')}`;
    if (taken.get(id, id) === undefined) return id;
  }
}

/** `users.insert`. Ruling: a user created through the API has the staff role. */
export function insertUser(call: Call): ApiResponse {
  const domain = domainOf(call);
  const body = jsonBody(call);
  const email = primaryEmail(call, body.primaryEmail);
  const name = readName(call, body.name);
  checkPassword(call, body);
  const ou = stringField(call, body, 'orgUnitPath');
  const unit = ou
    ? targetOrgUnit(call, ou)
    : resolveOrgUnit(call, domain.db, '/');
  const suspended = booleanField(call, body, 'suspended') ?? false;
  const changePassword =
    booleanField(call, body, 'changePasswordAtNextLogin') ?? false;
  const external =
    body.externalIds === undefined
      ? { json: null, first: null }
      : readExternalIds(call, body.externalIds);
  if (emailInUse(domain.db, email)) throw duplicate();
  const id = newUserId(call, email);
  const ord = Number(
    row<{ next: number }>(
      domain.db
        .prepare(
          'SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM (SELECT ord FROM users UNION ALL SELECT ord FROM deleted_users)',
        )
        .get(),
    )!.next,
  );
  transaction(domain.db, () => {
    saveBeforeImage(domain.db, 'users', id, call.now, searchDelayMs(call));
    domain.db
      .prepare(
        "INSERT INTO users (id, primary_email, given_name, family_name, full_name, org_unit_path, is_admin, suspended, suspension_reason, external_id, role, school, creation_time, last_login_time, ord, change_password_at_next_login, external_ids) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'staff', NULL, ?, NULL, ?, ?, ?)",
      )
      .run(
        id,
        email,
        name.given,
        name.family,
        `${name.given} ${name.family}`,
        unit.path,
        suspended ? 1 : 0,
        suspended ? 'ADMIN' : null,
        external.first,
        call.now,
        ord,
        changePassword ? 1 : 0,
        external.json,
      );
  });
  return { status: 200, body: writtenUser(call, id) };
}
