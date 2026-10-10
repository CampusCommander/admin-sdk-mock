import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ApiResponse, Call } from '../http/types.ts';
import { saveBeforeImage, saveBeforeImagesWhere } from '../store/lag.ts';
import { row, transaction } from '../store/sqlite.ts';
import { settleCommands } from './command-effects.ts';
import {
  domainOf,
  invalidArgument,
  jsonBody,
  resolveCustomer,
  searchDelayMs,
  stringField,
} from './common.ts';
import {
  orgUnitResource,
  resolveOrgUnit,
  targetOrgUnit,
  type OuRow,
} from './orgunits.ts';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Ruling: a name already used under the same parent answers 400. Names compare without case. */
const NAME_TAKEN =
  'Invalid Input: an org unit with this name already exists under the parent.';

function readName(call: Call, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('/'))
    throw invalidArgument(call, 'Invalid Input: name');
  return value.trim();
}

/** The parent that the body names by path or by ID, if any. */
function namedParent(
  call: Call,
  body: Record<string, unknown>,
): OuRow | undefined {
  const path = stringField(call, body, 'parentOrgUnitPath');
  if (path) return targetOrgUnit(call, path);
  const id = stringField(call, body, 'parentOrgUnitId');
  if (id) return targetOrgUnit(call, id.startsWith('id:') ? id : `id:${id}`);
  return undefined;
}

const childPath = (parent: OuRow, name: string): string =>
  parent.path === '/' ? `/${name}` : `${parent.path}/${name}`;

function pathTaken(db: DatabaseSync, path: string, exceptId = ''): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM orgunits WHERE lower(path) = lower(?) AND org_unit_id != ?',
      )
      .get(path, exceptId) !== undefined
  );
}

/** 13 lowercase alphanumeric characters from crypto randomness, so a deleted ID is never reused. */
function randomId(): string {
  let out = '';
  for (const byte of randomBytes(13)) out += ALPHABET[byte % 36];
  return out;
}

function newOrgUnitId(call: Call): string {
  const domain = domainOf(call);
  const exists = domain.db.prepare(
    'SELECT 1 FROM orgunits WHERE org_unit_id = ?',
  );
  for (;;) {
    const id = `id:0${randomId()}`;
    if (exists.get(id) === undefined) return id;
  }
}

function storedUnit(db: DatabaseSync, id: string): OuRow {
  return row<OuRow>(
    db.prepare('SELECT * FROM orgunits WHERE org_unit_id = ?').get(id),
  )!;
}

/**
 * Rewrite every path below `unit` from its old path to `newPath`.
 * Each changed OU, user, and device receives a before-image. Returns the rows changed.
 */
function cascade(
  db: DatabaseSync,
  unit: OuRow,
  newPath: string,
  newParent: OuRow,
  now: number,
  delay: number,
): number {
  const old = unit.path;
  const tree = [old, `${old}/`, `${old}0`];
  const units = '(path = ? OR (path >= ? AND path < ?))';
  const members =
    '(org_unit_path = ? OR (org_unit_path >= ? AND org_unit_path < ?))';
  saveBeforeImagesWhere(db, 'orgunits', units, tree, now, delay);
  saveBeforeImagesWhere(db, 'users', members, tree, now, delay);
  saveBeforeImagesWhere(db, 'devices', members, tree, now, delay);
  const depthDelta = newParent.depth + 1 - unit.depth;
  let changed = Number(
    db
      .prepare(
        `UPDATE orgunits SET path = ? || substr(path, length(?) + 1), depth = depth + ?, parent_path = CASE WHEN org_unit_id = ? THEN parent_path ELSE ? || substr(parent_path, length(?) + 1) END WHERE ${units}`,
      )
      .run(newPath, old, depthDelta, unit.org_unit_id, newPath, old, ...tree)
      .changes,
  );
  for (const table of ['users', 'devices'])
    changed += Number(
      db
        .prepare(
          `UPDATE ${table} SET org_unit_path = ? || substr(org_unit_path, length(?) + 1) WHERE ${members}`,
        )
        .run(newPath, old, ...tree).changes,
    );
  return changed;
}

/** `orgunits.insert`. */
export function insertOrgUnit(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  const body = jsonBody(call);
  const name = readName(call, body.name);
  const parent = namedParent(call, body);
  if (!parent) throw invalidArgument(call, 'Invalid Input: parentOrgUnitPath');
  const path = childPath(parent, name);
  if (pathTaken(domain.db, path)) throw invalidArgument(call, NAME_TAKEN);
  const description = stringField(call, body, 'description') ?? '';
  const id = newOrgUnitId(call);
  const ord = Number(
    row<{ next: number }>(
      domain.db
        .prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM orgunits')
        .get(),
    )!.next,
  );
  transaction(domain.db, () => {
    saveBeforeImage(domain.db, 'orgunits', id, call.now, searchDelayMs(call));
    domain.db
      .prepare(
        "INSERT INTO orgunits (org_unit_id, path, name, description, parent_id, parent_path, depth, kind, ord) VALUES (?, ?, ?, ?, ?, ?, ?, 'container', ?)",
      )
      .run(
        id,
        path,
        name,
        description,
        parent.org_unit_id,
        parent.path,
        parent.depth + 1,
        ord,
      );
  });
  return { status: 200, body: orgUnitResource(storedUnit(domain.db, id)) };
}

/** `orgunits.update` and `orgunits.patch`. Both change only the fields in the body. */
export function updateOrgUnit(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  settleCommands(call);
  const unit = resolveOrgUnit(call, domain.db, call.params.orgUnitPath);
  const body = jsonBody(call);
  const rawName = stringField(call, body, 'name');
  const name =
    rawName === undefined || rawName === null
      ? unit.name
      : readName(call, rawName);
  const named = namedParent(call, body);
  const description = stringField(call, body, 'description');
  if (unit.parent_id === null && (name !== unit.name || named))
    throw invalidArgument(
      call,
      'Invalid Input: the root org unit cannot be renamed or moved.',
    );
  const parent =
    named ??
    (unit.parent_id === null
      ? undefined
      : storedUnit(domain.db, unit.parent_id));
  let path = unit.path;
  if (parent) {
    if (
      parent.org_unit_id === unit.org_unit_id ||
      parent.path.startsWith(`${unit.path}/`)
    )
      throw invalidArgument(
        call,
        'Invalid Input: an org unit cannot move into its own subtree.',
      );
    path = childPath(parent, name);
    if (path !== unit.path && pathTaken(domain.db, path, unit.org_unit_id))
      throw invalidArgument(call, NAME_TAKEN);
  }
  const delay = searchDelayMs(call);
  let cascaded = 0;
  transaction(domain.db, () => {
    if (parent && path !== unit.path)
      cascaded = cascade(domain.db, unit, path, parent, call.now, delay);
    else
      saveBeforeImage(domain.db, 'orgunits', unit.org_unit_id, call.now, delay);
    domain.db
      .prepare(
        'UPDATE orgunits SET name = ?, description = ?, parent_id = ?, parent_path = ? WHERE org_unit_id = ?',
      )
      .run(
        name,
        description ?? unit.description,
        parent?.org_unit_id ?? null,
        parent?.path ?? null,
        unit.org_unit_id,
      );
  });
  return {
    status: 200,
    scanned: cascaded,
    body: orgUnitResource(storedUnit(domain.db, unit.org_unit_id)),
  };
}

/** `orgunits.delete`. Only an empty OU other than the root can be deleted. */
export function deleteOrgUnit(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  settleCommands(call);
  const unit = resolveOrgUnit(call, domain.db, call.params.orgUnitPath);
  if (unit.parent_id === null)
    throw invalidArgument(
      call,
      'Invalid Input: the root org unit cannot be deleted.',
    );
  const busy = domain.db
    .prepare(
      'SELECT 1 FROM orgunits WHERE parent_id = ? UNION ALL SELECT 1 FROM users WHERE org_unit_path = ? UNION ALL SELECT 1 FROM devices WHERE org_unit_path = ? LIMIT 1',
    )
    .get(unit.org_unit_id, unit.path, unit.path);
  if (busy !== undefined)
    throw invalidArgument(
      call,
      'Invalid Input: the org unit holds child org units, users, or devices.',
    );
  transaction(domain.db, () => {
    saveBeforeImage(
      domain.db,
      'orgunits',
      unit.org_unit_id,
      call.now,
      searchDelayMs(call),
    );
    domain.db
      .prepare('DELETE FROM orgunits WHERE org_unit_id = ?')
      .run(unit.org_unit_id);
  });
  return { status: 204 };
}
