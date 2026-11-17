import type { DatabaseSync } from 'node:sqlite';
import type { Call } from '../http/types.ts';
import { rows } from '../store/sqlite.ts';
import { invalidArgument } from './common.ts';
import {
  FIELD_TYPES,
  MAX_VALUE_TEXT,
  ensureCustomTables,
  findSchema,
  hasCustomTables,
  type FieldRow,
  type FieldType,
} from './schemas.ts';

/** The entry types of a multi-valued field. */
const ENTRY_TYPES = ['work', 'home', 'other', 'custom'] as const;

/** The values of one user: `schemaName` to `{ fieldName: value }`. */
export type CustomValues = Record<string, Record<string, unknown>>;

/** One row of `user_custom_values`. */
interface ValueRow {
  user_id: string;
  schema_name: string;
  field_name: string;
  value_json: string;
}

/** The extra user fields of the opt-in seed. */
export interface ProfileExtra {
  archived: boolean;
  enrolled2sv: boolean;
  organizations?: unknown[];
}

/** The extra user fields that a read renders beside the built ones. */
export interface UserExtra {
  customSchemas?: CustomValues;
  archived?: boolean;
  isEnrolledIn2Sv?: boolean;
  organizations?: unknown[];
}

/**
 * The text that a custom query matches. A list stores its entries as a JSON array, so a
 * predicate compares one entry at a time instead of a flattened list.
 */
export function valueSearchText(value: unknown): string {
  if (Array.isArray(value))
    return JSON.stringify(
      value.map((entry) => String((entry as { value?: unknown }).value ?? '')),
    );
  return String(value);
}

/** Store one value, replacing the value that the user holds for the field. */
export function putCustomValue(
  db: DatabaseSync,
  userId: string,
  schemaName: string,
  fieldName: string,
  value: unknown,
): void {
  ensureCustomTables(db);
  db.prepare(
    'INSERT INTO user_custom_values (user_id, schema_name, field_name, value_json, search_text) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, schema_name, field_name) DO UPDATE SET value_json = excluded.value_json, search_text = excluded.search_text',
  ).run(
    userId,
    schemaName,
    fieldName,
    JSON.stringify(value),
    valueSearchText(value),
  );
}

/** Remove one value of one user. */
export function deleteCustomValue(
  db: DatabaseSync,
  userId: string,
  schemaName: string,
  fieldName: string,
): void {
  if (!hasCustomTables(db)) return;
  db.prepare(
    'DELETE FROM user_custom_values WHERE user_id = ? AND schema_name = ? AND field_name = ?',
  ).run(userId, schemaName, fieldName);
}

/** Read the values of the given users. A mask keeps the schemas that it names. */
export function customValuesFor(
  db: DatabaseSync,
  ids: readonly string[],
  mask?: readonly string[],
): Map<string, CustomValues> {
  const out = new Map<string, CustomValues>();
  if (ids.length === 0 || (mask !== undefined && mask.length === 0)) return out;
  if (!hasCustomTables(db)) return out;
  const marks = ids.map(() => '?').join(', ');
  const masked =
    mask === undefined
      ? ''
      : ` AND schema_name IN (${mask.map(() => '?').join(', ')})`;
  const found = rows<ValueRow>(
    db
      .prepare(
        `SELECT user_id, schema_name, field_name, value_json FROM user_custom_values WHERE user_id IN (${marks})${masked} ORDER BY user_id, schema_name, field_name`,
      )
      .all(...ids, ...(mask ?? [])),
  );
  for (const entry of found) {
    let schemas = out.get(entry.user_id);
    if (!schemas)
      out.set(entry.user_id, (schemas = Object.create(null) as CustomValues));
    let fields = schemas[entry.schema_name];
    // A schema or a field may legally be named `__proto__` or `constructor`.
    if (!fields)
      schemas[entry.schema_name] = fields = Object.create(null) as Record<
        string,
        unknown
      >;
    fields[entry.field_name] = JSON.parse(entry.value_json) as unknown;
  }
  return out;
}

/** Read the opt-in extras of the given users. */
export function profileExtraFor(
  db: DatabaseSync,
  ids: readonly string[],
): Map<string, ProfileExtra> {
  const out = new Map<string, ProfileExtra>();
  if (ids.length === 0 || !hasCustomTables(db)) return out;
  for (const entry of rows<{
    user_id: string;
    archived: number;
    enrolled_in_2sv: number;
    organizations: string | null;
  }>(
    db
      .prepare(
        `SELECT user_id, archived, enrolled_in_2sv, organizations FROM user_profile_extra WHERE user_id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids),
  ))
    out.set(entry.user_id, {
      archived: entry.archived === 1,
      enrolled2sv: entry.enrolled_in_2sv === 1,
      ...(entry.organizations
        ? { organizations: JSON.parse(entry.organizations) as unknown[] }
        : {}),
    });
  return out;
}

/** The custom field that a query name refers to, when the domain knows it. */
export function customField(
  db: DatabaseSync,
  schemaName: string,
  fieldName: string,
): FieldRow | undefined {
  if (!hasCustomTables(db)) return undefined;
  const schema = findSchema(db, schemaName);
  if (!schema) return undefined;
  return rows<FieldRow>(
    db
      .prepare(
        'SELECT * FROM custom_schema_fields WHERE schema_id = ? AND field_name = ?',
      )
      .all(schema.schema_id, fieldName),
  )[0];
}

/**
 * The extras of a page of users: the values that the projection asks for, and the fields
 * of the opt-in seed. A domain that holds neither keeps the resource of 0.3.0.
 */
export function userExtras(
  db: DatabaseSync,
  ids: readonly string[],
  projection: 'basic' | 'full' | 'custom',
  mask?: readonly string[],
): Map<string, UserExtra> {
  const out = new Map<string, UserExtra>();
  if (ids.length === 0) return out;
  const profiles = profileExtraFor(db, ids);
  const values =
    projection === 'full'
      ? customValuesFor(db, ids)
      : projection === 'custom' && mask !== undefined
        ? customValuesFor(db, ids, mask)
        : new Map<string, CustomValues>();
  for (const id of ids) {
    const custom = values.get(id);
    const profile = profiles.get(id);
    const extra: UserExtra = {
      ...(custom && Object.keys(custom).length > 0
        ? { customSchemas: custom }
        : {}),
      ...(profile
        ? {
            archived: profile.archived,
            isEnrolledIn2Sv: profile.enrolled2sv,
            ...(profile.organizations
              ? { organizations: profile.organizations }
              : {}),
          }
        : {}),
    };
    if (Object.keys(extra).length > 0) out.set(id, extra);
  }
  return out;
}

/** The schema names of a `projection=custom` read. An absent mask names none. */
export function customFieldMask(call: Call): string[] | undefined {
  const raw = call.request.query.get('customFieldMask');
  if (raw === null) return undefined;
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return names.length > 0 ? names : undefined;
}

/** One entry of a multi-valued field: `{ value, type?, customType? }`. */
function multiEntry(call: Call, value: unknown, label: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidArgument(call, `Invalid Input: ${label}`);
  const entry = value as Record<string, unknown>;
  if (!Object.hasOwn(entry, 'value'))
    throw invalidArgument(call, `Invalid Input: ${label}`);
  const type = entry.type;
  if (
    type !== undefined &&
    type !== null &&
    (typeof type !== 'string' ||
      !ENTRY_TYPES.includes(type as (typeof ENTRY_TYPES)[number]))
  )
    throw invalidArgument(call, `Invalid Input: ${label}.type`);
  const customType = entry.customType;
  if (
    customType !== undefined &&
    customType !== null &&
    (typeof customType !== 'string' || customType.trim() === '')
  )
    throw invalidArgument(call, `Invalid Input: ${label}.customType`);
  return entry;
}

/** True for a real calendar date: the month and the day exist in that year. */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

/** One value of a field, checked against its info type. */
function readValue(
  call: Call,
  field: FieldRow,
  value: unknown,
  label: string,
): unknown {
  if (field.multi_valued === 1) {
    if (!Array.isArray(value))
      throw invalidArgument(call, `Invalid Input: ${label}`);
    const single = { ...field, multi_valued: 0 };
    return value.map((entry, index) => {
      const at = `${label}[${index}]`;
      const checked = multiEntry(call, entry, at) as Record<string, unknown>;
      return {
        ...checked,
        value: readValue(call, single, checked.value, `${at}.value`),
      };
    });
  }
  if (Array.isArray(value))
    throw invalidArgument(call, `Invalid Input: ${label}`);
  const type = field.field_type as FieldType;
  if (!FIELD_TYPES.includes(type)) return value;
  switch (type) {
    case 'INT64': {
      const number =
        typeof value === 'string' && /^-?\d+$/.test(value)
          ? Number(value)
          : value;
      if (typeof number !== 'number' || !Number.isSafeInteger(number))
        throw invalidArgument(call, `Invalid Input: ${label}`);
      return number;
    }
    case 'DOUBLE': {
      const number =
        typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : value;
      if (typeof number !== 'number' || !Number.isFinite(number))
        throw invalidArgument(call, `Invalid Input: ${label}`);
      return number;
    }
    case 'BOOL':
      if (typeof value !== 'boolean')
        throw invalidArgument(call, `Invalid Input: ${label}`);
      return value;
    case 'DATE':
      if (typeof value !== 'string' || !isCalendarDate(value))
        throw invalidArgument(call, `Invalid Input: ${label}`);
      return value;
    case 'EMAIL':
      if (
        typeof value !== 'string' ||
        [...value].length > MAX_VALUE_TEXT ||
        !/^[^@\s]+@[^@\s]+$/.test(value)
      )
        throw invalidArgument(call, `Invalid Input: ${label}`);
      return value;
    default: {
      if (typeof value !== 'string' || value === '')
        throw invalidArgument(call, `Invalid Input: ${label}`);
      if ([...value].length > MAX_VALUE_TEXT)
        throw invalidArgument(call, `Invalid Input: ${label} is too long.`);
      return value;
    }
  }
}

/**
 * Merge a `customSchemas` body into the values of one user. A field that the body leaves
 * out stays, and `null` deletes a value or every value of a category. An attribute that
 * the domain does not know answers 400, a marked hypothesis until checks L2 and L3.
 */
export function mergeCustomValues(
  call: Call,
  db: DatabaseSync,
  userId: string,
  body: unknown,
): void {
  if (body === null) {
    if (hasCustomTables(db))
      db.prepare('DELETE FROM user_custom_values WHERE user_id = ?').run(
        userId,
      );
    return;
  }
  if (typeof body !== 'object' || Array.isArray(body))
    throw invalidArgument(call, 'Invalid Input: customSchemas');
  ensureCustomTables(db);
  for (const [schemaName, fields] of Object.entries(
    body as Record<string, unknown>,
  )) {
    if (fields === null) {
      db.prepare(
        'DELETE FROM user_custom_values WHERE user_id = ? AND schema_name = ?',
      ).run(userId, schemaName);
      continue;
    }
    if (typeof fields !== 'object' || Array.isArray(fields))
      throw invalidArgument(call, `Invalid Input: customSchemas.${schemaName}`);
    for (const [fieldName, value] of Object.entries(
      fields as Record<string, unknown>,
    )) {
      const field = customField(db, schemaName, fieldName);
      if (!field)
        throw invalidArgument(
          call,
          `Invalid Input: customSchemas.${schemaName}.${fieldName}`,
        );
      if (value === null) {
        deleteCustomValue(db, userId, schemaName, fieldName);
        continue;
      }
      putCustomValue(
        db,
        userId,
        schemaName,
        fieldName,
        readValue(
          call,
          field,
          value,
          `customSchemas.${schemaName}.${fieldName}`,
        ),
      );
    }
  }
}
