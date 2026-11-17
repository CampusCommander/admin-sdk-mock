import type { DatabaseSync } from 'node:sqlite';
import { ApiError, directoryError } from '../http/errors.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import { createRandom } from '../random.ts';
import { row, rows, transaction } from '../store/sqlite.ts';
import {
  domainOf,
  duplicate,
  etag,
  invalidArgument,
  jsonBody,
  notFound,
  resolveCustomer,
} from './common.ts';

/** The field types of the discovery document. */
export const FIELD_TYPES = [
  'STRING',
  'INT64',
  'DOUBLE',
  'BOOL',
  'EMAIL',
  'PHONE',
  'DATE',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const READ_ACCESS = ['ALL_DOMAIN_USERS', 'ADMINS_AND_SELF'] as const;
/** Letters, digits, `_`, and `-`, as the Google guide states. */
const NAME = /^[A-Za-z0-9_-]{1,500}$/;
const IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Ruling: at most 100 schemas and 100 fields for each customer. */
export const SCHEMA_LIMIT = 100;
export const FIELD_LIMIT = 100;
/** The Google guide limits a single value to 500 characters. */
export const MAX_VALUE_TEXT = 500;
const MAX_TEXT = 2000;

/**
 * The tables of the schemas resource and the custom values. They are created on the
 * first schema request or by the opt-in seed, so a domain that never uses them keeps
 * the database of 0.3.0 byte for byte.
 */
export const CUSTOM_TABLES = `
CREATE TABLE IF NOT EXISTS custom_schemas (
  schema_id TEXT PRIMARY KEY,
  schema_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ord INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_schema_fields (
  schema_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  field_type TEXT NOT NULL,
  multi_valued INTEGER NOT NULL,
  indexed INTEGER NOT NULL,
  read_access_type TEXT NOT NULL,
  numeric_min REAL,
  numeric_max REAL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (schema_id, field_name)
);
CREATE INDEX IF NOT EXISTS custom_schema_fields_id ON custom_schema_fields (field_id);
CREATE TABLE IF NOT EXISTS user_custom_values (
  user_id TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  PRIMARY KEY (user_id, schema_name, field_name)
);
CREATE INDEX IF NOT EXISTS user_custom_values_field ON user_custom_values (schema_name, field_name);
CREATE TABLE IF NOT EXISTS user_profile_extra (
  user_id TEXT PRIMARY KEY,
  archived INTEGER NOT NULL DEFAULT 0,
  enrolled_in_2sv INTEGER NOT NULL DEFAULT 0,
  organizations TEXT
);
`;

const READY = new WeakSet<DatabaseSync>();

/**
 * Create the custom tables when they are missing. DDL inside a transaction disappears
 * again on a rollback, so such a call leaves the readiness cache alone.
 */
export function ensureCustomTables(db: DatabaseSync): void {
  if (READY.has(db)) return;
  db.exec(CUSTOM_TABLES);
  if (!db.isTransaction) READY.add(db);
}

/** True when the domain holds the custom tables. Reads use it, so they create nothing. */
export function hasCustomTables(db: DatabaseSync): boolean {
  if (READY.has(db)) return true;
  const found =
    row<{ name: string }>(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_schemas'",
        )
        .get(),
    ) !== undefined;
  if (found && !db.isTransaction) READY.add(db);
  return found;
}

export interface SchemaRow {
  schema_id: string;
  schema_name: string;
  display_name: string;
  revision: number;
  ord: number;
}

export interface FieldRow {
  schema_id: string;
  field_id: string;
  field_name: string;
  display_name: string;
  field_type: string;
  multi_valued: number;
  indexed: number;
  read_access_type: string;
  numeric_min: number | null;
  numeric_max: number | null;
  ord: number;
}

interface Numeric {
  minValue?: number;
  maxValue?: number;
}

interface FieldInput {
  fieldId?: string;
  fieldName: string;
  fieldType: string;
  displayName: string;
  multiValued: boolean;
  indexed: boolean;
  readAccessType: string;
  numeric?: Numeric;
}

function numericSpec(field: FieldRow): Numeric | undefined {
  if (field.numeric_min === null && field.numeric_max === null)
    return undefined;
  return {
    ...(field.numeric_min !== null ? { minValue: field.numeric_min } : {}),
    ...(field.numeric_max !== null ? { maxValue: field.numeric_max } : {}),
  };
}

/** One field of the schema resource, with the defaults that the guide applies. */
export function fieldResource(field: FieldRow): Record<string, unknown> {
  const numeric = numericSpec(field);
  const body = {
    kind: 'admin#directory#schema#fieldspec',
    fieldId: field.field_id,
    fieldName: field.field_name,
    fieldType: field.field_type,
    displayName: field.display_name,
    multiValued: field.multi_valued === 1,
    indexed: field.indexed === 1,
    readAccessType: field.read_access_type,
    ...(numeric ? { numericIndexingSpec: numeric } : {}),
  };
  return { ...body, etag: etag(body) };
}

/** One schema of the list or of a read. Each write gives it a new etag. */
export function schemaResource(
  schema: SchemaRow,
  fields: readonly FieldRow[],
): Record<string, unknown> {
  return {
    kind: 'admin#directory#schema',
    etag: etag({ schemaId: schema.schema_id, revision: schema.revision }),
    schemaId: schema.schema_id,
    schemaName: schema.schema_name,
    displayName: schema.display_name,
    fields: fields.map(fieldResource),
  };
}

export function fieldsOf(db: DatabaseSync, schemaId: string): FieldRow[] {
  return rows<FieldRow>(
    db
      .prepare(
        'SELECT * FROM custom_schema_fields WHERE schema_id = ? ORDER BY ord',
      )
      .all(schemaId),
  );
}

/** Find a schema by its immutable ID or by its name. */
export function findSchema(
  db: DatabaseSync,
  key: string,
): SchemaRow | undefined {
  return row<SchemaRow>(
    db
      .prepare(
        'SELECT * FROM custom_schemas WHERE schema_id = ? OR schema_name = ?',
      )
      .get(key, key),
  );
}

function fieldCount(db: DatabaseSync): number {
  return Number(
    row<{ n: number }>(
      db.prepare('SELECT count(*) AS n FROM custom_schema_fields').get(),
    )?.n ?? 0,
  );
}

function schemaCount(db: DatabaseSync): number {
  return Number(
    row<{ n: number }>(
      db.prepare('SELECT count(*) AS n FROM custom_schemas').get(),
    )?.n ?? 0,
  );
}

function text(call: Call, value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw invalidArgument(call, `Invalid Input: ${label}`);
  if ([...value].length > MAX_TEXT)
    throw invalidArgument(call, `Invalid Input: ${label} is too long.`);
  return value;
}

function name(call: Call, value: unknown, label: string): string {
  const value$ = text(call, value, label);
  if (!NAME.test(value$))
    throw invalidArgument(call, `Invalid Input: ${label}`);
  return value$;
}

function flag(
  call: Call,
  value: unknown,
  label: string,
  fallback: boolean,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean')
    throw invalidArgument(call, `Invalid Input: ${label}`);
  return value;
}

function readNumeric(call: Call, value: unknown): Numeric | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value))
    throw invalidArgument(call, 'Invalid Input: numericIndexingSpec');
  const spec = value as Record<string, unknown>;
  const out: Numeric = {};
  for (const key of ['minValue', 'maxValue'] as const) {
    const number = spec[key];
    if (number === undefined || number === null) continue;
    if (typeof number !== 'number' || !Number.isFinite(number))
      throw invalidArgument(call, `Invalid Input: numericIndexingSpec.${key}`);
    out[key] = number;
  }
  if (
    out.minValue !== undefined &&
    out.maxValue !== undefined &&
    out.minValue > out.maxValue
  )
    throw invalidArgument(call, 'Invalid Input: numericIndexingSpec');
  return Object.keys(out).length > 0 ? out : undefined;
}

function readField(call: Call, value: unknown, index: number): FieldInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidArgument(call, `Invalid Input: fields[${index}]`);
  const field = value as Record<string, unknown>;
  const fieldType = field.fieldType;
  if (
    typeof fieldType !== 'string' ||
    !FIELD_TYPES.includes(fieldType as FieldType)
  )
    throw invalidArgument(call, `Invalid Input: fields[${index}].fieldType`);
  const readAccess = field.readAccessType;
  if (
    readAccess !== undefined &&
    readAccess !== null &&
    (typeof readAccess !== 'string' ||
      !READ_ACCESS.includes(readAccess as (typeof READ_ACCESS)[number]))
  )
    throw invalidArgument(
      call,
      `Invalid Input: fields[${index}].readAccessType`,
    );
  const fieldId = field.fieldId;
  if (fieldId !== undefined && fieldId !== null && typeof fieldId !== 'string')
    throw invalidArgument(call, `Invalid Input: fields[${index}].fieldId`);
  return {
    ...(typeof fieldId === 'string' ? { fieldId } : {}),
    fieldName: name(call, field.fieldName, `fields[${index}].fieldName`),
    fieldType,
    displayName: text(call, field.displayName, `fields[${index}].displayName`),
    multiValued: flag(
      call,
      field.multiValued,
      `fields[${index}].multiValued`,
      false,
    ),
    indexed: flag(call, field.indexed, `fields[${index}].indexed`, true),
    readAccessType: (readAccess as string | undefined) ?? 'ALL_DOMAIN_USERS',
    numeric: readNumeric(call, field.numericIndexingSpec),
  };
}

interface SchemaInput {
  schemaName: string;
  displayName: string;
  fields: FieldInput[];
}

function readSchema(call: Call, body: Record<string, unknown>): SchemaInput {
  const raw = body.fields;
  if (!Array.isArray(raw) || raw.length === 0)
    throw invalidArgument(call, 'Invalid Input: fields');
  const fields = raw.map((field, index) => readField(call, field, index));
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.fieldName))
      throw invalidArgument(call, 'Invalid Input: fields[].fieldName');
    seen.add(field.fieldName);
  }
  return {
    schemaName: name(call, body.schemaName, 'schemaName'),
    displayName: text(call, body.displayName, 'displayName'),
    fields,
  };
}

/** A unique ID for a schema or a field, derived from a source string and a label. */
export function makeId(
  source: string,
  label: string,
  taken: (id: string) => boolean,
): string {
  const random = createRandom(`custom/${source}/${label}`);
  for (;;) {
    const id = random.string(12, IDS);
    if (!taken(id)) return id;
  }
}

function newId(
  call: Call,
  label: string,
  taken: (id: string) => boolean,
): string {
  return makeId(domainOf(call).spec.seed, label, taken);
}

/** A stale `If-Match` answers 412. The header is optional, as Google documents it. */
function checkIfMatch(call: Call, schema: SchemaRow): void {
  const header = call.request.headers['if-match'];
  if (header === undefined) return;
  if (
    header.trim() ===
    etag({ schemaId: schema.schema_id, revision: schema.revision })
  )
    return;
  throw new ApiError(
    directoryError(412, 'conditionNotMet', 'Precondition Failed', {
      extra: { status: 'FAILED_PRECONDITION' },
    }),
  );
}

function customerOf(call: Call): string {
  return resolveCustomer(call, call.params.customerId);
}

export function listSchemas(call: Call): ApiResponse {
  customerOf(call);
  const db = domainOf(call).db;
  ensureCustomTables(db);
  const schemas = rows<SchemaRow>(
    db.prepare('SELECT * FROM custom_schemas ORDER BY ord').all(),
  ).map((schema) => schemaResource(schema, fieldsOf(db, schema.schema_id)));
  return {
    status: 200,
    items: schemas.length,
    body: {
      kind: 'admin#directory#schemas',
      etag: etag(schemas),
      schemas,
    },
  };
}

export function getSchema(call: Call): ApiResponse {
  customerOf(call);
  const db = domainOf(call).db;
  ensureCustomTables(db);
  const schema = findSchema(db, call.params.schemaKey);
  if (!schema) throw notFound('schemaKey');
  return {
    status: 200,
    items: 1,
    body: schemaResource(schema, fieldsOf(db, schema.schema_id)),
  };
}

/** How many incarnations of a schema name the domain has created so far. */
function storedIncarnations(db: DatabaseSync, schemaName: string): number {
  return Number(
    row<{ value: string }>(
      db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(incarnationKey(schemaName)),
    )?.value ?? 0,
  );
}

/** The meta key that counts the incarnations of one schema name. */
function incarnationKey(schemaName: string): string {
  return `custom-schema-incarnation/${schemaName}`;
}

/** The next incarnation of a schema name: a recreate never reuses the ID of the deleted one. */
function nextIncarnation(db: DatabaseSync, schemaName: string): number {
  return storedIncarnations(db, schemaName) + 1;
}

/** The incarnation of a live schema. A schema that the seed wrote has no row yet. */
function incarnationOf(db: DatabaseSync, schemaName: string): number {
  return storedIncarnations(db, schemaName) || 1;
}

export function insertSchema(call: Call): ApiResponse {
  const customer = customerOf(call);
  const db = domainOf(call).db;
  ensureCustomTables(db);
  const input = readSchema(call, jsonBody(call));
  if (findSchema(db, input.schemaName)) throw duplicate();
  if (schemaCount(db) >= SCHEMA_LIMIT)
    throw invalidArgument(call, `Limit reached: ${SCHEMA_LIMIT} schemas.`);
  if (fieldCount(db) + input.fields.length > FIELD_LIMIT)
    throw invalidArgument(call, `Limit reached: ${FIELD_LIMIT} fields.`);
  const incarnation = nextIncarnation(db, input.schemaName);
  const schemaId = newId(
    call,
    `schema/${customer}/${input.schemaName}/${incarnation}`,
    (id) => findSchema(db, id) !== undefined,
  );
  const takenFields = new Set<string>();
  const fieldIds = input.fields.map((field) => {
    const id = newId(
      call,
      `field/${customer}/${input.schemaName}/${incarnation}/${field.fieldName}`,
      (candidate) => takenFields.has(candidate),
    );
    takenFields.add(id);
    return id;
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(incarnationKey(input.schemaName), String(incarnation));
    db.prepare(
      'INSERT INTO custom_schemas (schema_id, schema_name, display_name, revision, ord) VALUES (?, ?, ?, 1, ?)',
    ).run(schemaId, input.schemaName, input.displayName, schemaCount(db));
    const insert = db.prepare(
      'INSERT INTO custom_schema_fields (schema_id, field_id, field_name, display_name, field_type, multi_valued, indexed, read_access_type, numeric_min, numeric_max, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    input.fields.forEach((field, index) =>
      insert.run(
        schemaId,
        fieldIds[index],
        field.fieldName,
        field.displayName,
        field.fieldType,
        field.multiValued ? 1 : 0,
        field.indexed ? 1 : 0,
        field.readAccessType,
        field.numeric?.minValue ?? null,
        field.numeric?.maxValue ?? null,
        index,
      ),
    );
  });
  const schema = findSchema(db, schemaId)!;
  return {
    status: 200,
    items: 1,
    body: schemaResource(schema, fieldsOf(db, schemaId)),
  };
}

/** The entry form of a value that a single-valued field held before it widened. */
function widenedValue(value: unknown): {
  valueJson: string;
  searchText: string;
} {
  return {
    valueJson: JSON.stringify([{ value }]),
    searchText: JSON.stringify([String(value)]),
  };
}

/**
 * A single-valued field that becomes multi-valued keeps the values that users already
 * hold. Each value becomes the single entry of its list, in storage and in the search
 * text, so a read shows the entry form and a search still matches the value.
 */
function widenValues(
  db: DatabaseSync,
  schemaName: string,
  fieldName: string,
): void {
  const found = rows<{ user_id: string; value_json: string }>(
    db
      .prepare(
        'SELECT user_id, value_json FROM user_custom_values WHERE schema_name = ? AND field_name = ?',
      )
      .all(schemaName, fieldName),
  );
  const update = db.prepare(
    'UPDATE user_custom_values SET value_json = ?, search_text = ? WHERE user_id = ? AND schema_name = ? AND field_name = ?',
  );
  for (const entry of found) {
    const value = JSON.parse(entry.value_json) as unknown;
    // A list is already in the entry form.
    if (Array.isArray(value)) continue;
    const next = widenedValue(value);
    update.run(
      next.valueJson,
      next.searchText,
      entry.user_id,
      schemaName,
      fieldName,
    );
  }
}

export function updateSchema(call: Call): ApiResponse {
  customerOf(call);
  const db = domainOf(call).db;
  ensureCustomTables(db);
  const current = findSchema(db, call.params.schemaKey);
  if (!current) throw notFound('schemaKey');
  checkIfMatch(call, current);
  const body = jsonBody(call);
  const existing = fieldsOf(db, current.schema_id);
  const input = readSchema(call, {
    schemaName: body.schemaName ?? current.schema_name,
    displayName: body.displayName ?? current.display_name,
    fields: body.fields,
  });
  if (input.schemaName !== current.schema_name)
    throw invalidArgument(call, 'Invalid Input: a schema cannot be renamed.');
  const byName = new Map(existing.map((field) => [field.field_name, field]));
  const byId = new Map(existing.map((field) => [field.field_id, field]));
  for (const field of input.fields) {
    if (field.fieldId !== undefined) {
      const named = byId.get(field.fieldId);
      if (named && named.field_name !== field.fieldName)
        throw invalidArgument(
          call,
          'Invalid Input: a field cannot be renamed.',
        );
    }
    const kept = byName.get(field.fieldName);
    if (kept) {
      if (kept.field_type !== field.fieldType)
        throw invalidArgument(
          call,
          'Invalid Input: a field type cannot change.',
        );
      if (kept.multi_valued === 1 && !field.multiValued)
        throw invalidArgument(
          call,
          'Invalid Input: a multi-valued field cannot become single-valued.',
        );
    }
  }
  const kept = new Set(input.fields.map((field) => field.fieldName));
  const removed = existing.filter((field) => !kept.has(field.field_name));
  const added = input.fields.filter((field) => !byName.has(field.fieldName));
  // A value written while the field was single-valued follows the multi-value entry form.
  const widened = input.fields.filter((field) => {
    const before = byName.get(field.fieldName);
    return (
      before !== undefined && before.multi_valued === 0 && field.multiValued
    );
  });
  if (fieldCount(db) - removed.length + added.length > FIELD_LIMIT)
    throw invalidArgument(call, `Limit reached: ${FIELD_LIMIT} fields.`);
  const customer = customerOf(call);
  const incarnation = incarnationOf(db, current.schema_name);
  const takenFields = new Set(existing.map((field) => field.field_id));
  const fieldIds = input.fields.map((field) => {
    const current = byName.get(field.fieldName);
    if (current) return current.field_id;
    const id = newId(
      call,
      `field/${customer}/${input.schemaName}/${incarnation}/${field.fieldName}`,
      (candidate) => takenFields.has(candidate),
    );
    takenFields.add(id);
    return id;
  });
  transaction(db, () => {
    db.prepare(
      'UPDATE custom_schemas SET display_name = ?, revision = revision + 1 WHERE schema_id = ?',
    ).run(input.displayName, current.schema_id);
    if (removed.length > 0) {
      const drop = db.prepare(
        'DELETE FROM custom_schema_fields WHERE schema_id = ? AND field_name = ?',
      );
      for (const field of removed) {
        drop.run(current.schema_id, field.field_name);
        // Ruling, marked hypothesis until check L3: a removed field loses its values.
        db.prepare(
          'DELETE FROM user_custom_values WHERE schema_name = ? AND field_name = ?',
        ).run(current.schema_name, field.field_name);
      }
    }
    const upsert = db.prepare(
      'INSERT INTO custom_schema_fields (schema_id, field_id, field_name, display_name, field_type, multi_valued, indexed, read_access_type, numeric_min, numeric_max, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (schema_id, field_name) DO UPDATE SET display_name = excluded.display_name, multi_valued = excluded.multi_valued, indexed = excluded.indexed, read_access_type = excluded.read_access_type, numeric_min = excluded.numeric_min, numeric_max = excluded.numeric_max, ord = excluded.ord',
    );
    input.fields.forEach((field, index) =>
      upsert.run(
        current.schema_id,
        fieldIds[index],
        field.fieldName,
        field.displayName,
        field.fieldType,
        field.multiValued ? 1 : 0,
        field.indexed ? 1 : 0,
        field.readAccessType,
        field.numeric?.minValue ?? null,
        field.numeric?.maxValue ?? null,
        index,
      ),
    );
    for (const field of widened)
      widenValues(db, current.schema_name, field.fieldName);
  });
  const updated = findSchema(db, current.schema_id)!;
  return {
    status: 200,
    items: 1,
    body: schemaResource(updated, fieldsOf(db, current.schema_id)),
  };
}

export function deleteSchema(call: Call): ApiResponse {
  customerOf(call);
  const db = domainOf(call).db;
  ensureCustomTables(db);
  const schema = findSchema(db, call.params.schemaKey);
  if (!schema) throw notFound('schemaKey');
  checkIfMatch(call, schema);
  transaction(db, () => {
    db.prepare('DELETE FROM custom_schema_fields WHERE schema_id = ?').run(
      schema.schema_id,
    );
    db.prepare('DELETE FROM custom_schemas WHERE schema_id = ?').run(
      schema.schema_id,
    );
    // Ruling, marked hypothesis until check L3: a delete removes every value of the schema.
    db.prepare('DELETE FROM user_custom_values WHERE schema_name = ?').run(
      schema.schema_name,
    );
  });
  return { status: 204 };
}
