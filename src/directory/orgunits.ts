import type { DatabaseSync } from 'node:sqlite';
import { ApiError, directoryError } from '../http/errors.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import { row, rows } from '../store/sqlite.ts';
import { domainOf, enumParam, resolveCustomer, withEtag } from './common.ts';

export interface OuRow {
  org_unit_id: string;
  path: string;
  name: string;
  description: string;
  parent_id: string | null;
  parent_path: string | null;
  depth: number;
  kind: string;
  ord: number;
}

/** The root carries no parent fields. Campus Commander relies on that shape. */
export function orgUnitResource(unit: OuRow): Record<string, unknown> {
  return withEtag({
    kind: 'admin#directory#orgUnit',
    name: unit.name,
    description: unit.description,
    orgUnitPath: unit.path,
    orgUnitId: unit.org_unit_id,
    ...(unit.parent_id
      ? { parentOrgUnitPath: unit.parent_path, parentOrgUnitId: unit.parent_id }
      : {}),
    blockInheritance: false,
  });
}

/** Resolve a path without its leading slash, a path with it, or an `id:` value. */
export function resolveOrgUnit(
  _call: Call,
  db: DatabaseSync,
  raw: string | null | undefined,
): OuRow {
  const value = (raw ?? '').trim();
  const found =
    value === '' || value === '/'
      ? row<OuRow>(db.prepare("SELECT * FROM orgunits WHERE path = '/'").get())
      : value.startsWith('id:')
        ? row<OuRow>(
            db
              .prepare('SELECT * FROM orgunits WHERE org_unit_id = ?')
              .get(value),
          )
        : row<OuRow>(
            db
              .prepare('SELECT * FROM orgunits WHERE path = ?')
              .get(`/${value.replace(/^\/+/, '')}`),
          );
  if (!found)
    throw new ApiError(directoryError(404, 'notFound', 'Org unit not found'));
  return found;
}

const TYPES = {
  all: 'all',
  children: 'children',
  allincludingparent: 'allIncludingParent',
} as const;

export function listOrgUnits(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  const type = enumParam(call, 'type', TYPES, 'children');
  const parent = resolveOrgUnit(
    call,
    domain.db,
    call.request.query.get('orgUnitPath'),
  );
  let units: OuRow[];
  if (type === 'children')
    units = rows<OuRow>(
      domain.db
        .prepare('SELECT * FROM orgunits WHERE parent_id = ? ORDER BY ord')
        .all(parent.org_unit_id),
    );
  else {
    const prefix = parent.path === '/' ? '/' : `${parent.path}/`;
    units = rows<OuRow>(
      domain.db
        .prepare(
          'SELECT * FROM orgunits WHERE substr(path, 1, ?) = ? AND path != ? ORDER BY ord',
        )
        .all(prefix.length, prefix, parent.path),
    );
    if (type === 'allIncludingParent') units = [parent, ...units];
  }
  const organizationUnits = units.map(orgUnitResource);
  return {
    status: 200,
    items: units.length,
    scanned: type === 'children' ? 0 : units.length,
    body: withEtag({
      kind: 'admin#directory#orgUnits',
      ...(organizationUnits.length > 0 ? { organizationUnits } : {}),
    }),
  };
}

export function getOrgUnit(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  return {
    status: 200,
    items: 1,
    body: orgUnitResource(
      resolveOrgUnit(call, domain.db, call.params.orgUnitPath),
    ),
  };
}
