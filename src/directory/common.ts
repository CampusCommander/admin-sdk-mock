import { createHash } from 'node:crypto';
import {
  ApiError,
  directoryError,
  notAuthorized,
  rpcError,
} from '../http/errors.ts';
import type { Call, OpenDomain } from '../http/types.ts';
import { listedRelation, type LaggedTable } from '../store/lag.ts';

export function etag(value: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 27)}"`;
}

export function withEtag<T extends Record<string, unknown>>(
  value: T,
): T & { etag: string } {
  return { ...value, etag: etag(value) };
}

export const iso = (ms: number | null | undefined): string | undefined =>
  ms === null || ms === undefined ? undefined : new Date(ms).toISOString();

export function domainOf(call: Call): OpenDomain {
  if (!call.domain || !call.access)
    throw new Error(`Route ${call.route.id} needs authentication.`);
  return call.domain;
}

/** Accept `my_customer` or the token's own customer ID. */
export function resolveCustomer(
  call: Call,
  value: string | undefined | null,
): string {
  const access = call.access;
  if (!access) throw new Error(`Route ${call.route.id} needs authentication.`);
  if (value === 'my_customer' || value === access.customerId)
    return access.customerId;
  throw new ApiError(
    call.route.api === 'chrome'
      ? notAuthorized('chrome')
      : directoryError(400, 'badRequest', 'Bad Request'),
  );
}

export function invalidArgument(
  call: Call,
  message: string,
  reason = 'invalid',
): ApiError {
  return new ApiError(
    call.route.api === 'chrome'
      ? rpcError(400, 'INVALID_ARGUMENT', message)
      : directoryError(400, reason, message),
  );
}

export function intParam(
  call: Call,
  name: string,
  options: { fallback: number; min: number; max: number; clamp?: boolean },
): number {
  const raw = call.request.query.get(name);
  if (raw === null || raw === '') return options.fallback;
  const value = Number(raw);
  const message = `Invalid value '${raw}'. Values must be within the range: [${options.min}, ${options.max}]`;
  if (!Number.isInteger(value) || value < options.min)
    throw invalidArgument(call, message);
  if (value > options.max && !options.clamp)
    throw invalidArgument(call, message);
  return Math.min(value, options.max);
}

export function boolParam(call: Call, name: string): boolean {
  const raw = call.request.query.get(name);
  if (raw === null || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw invalidArgument(call, `Invalid value '${raw}' for ${name}.`);
}

/** Match an enum parameter case-insensitively, ignoring underscores. */
export function enumParam<T extends string>(
  call: Call,
  name: string,
  values: Readonly<Record<string, T>>,
  fallback: T,
): T {
  const raw = call.request.query.get(name);
  if (raw === null || raw === '') return fallback;
  const found = values[raw.toLowerCase().replace(/_/g, '')];
  if (!found)
    throw invalidArgument(call, `Invalid value '${raw}' for ${name}.`);
  return found;
}

const invalidJson = () =>
  new ApiError(
    directoryError(400, 'invalid', 'Invalid JSON payload received.', {
      extra: { status: 'INVALID_ARGUMENT' },
    }),
  );

/** Parse a JSON object body. An empty body reads as an empty object. */
export function jsonBody(call: Call): Record<string, unknown> {
  const text = call.request.body.trim();
  if (text === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidJson();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidJson();
  return value as Record<string, unknown>;
}

/** Read an optional string field. `null` reads as null. `max` counts characters. */
export function stringField(
  call: Call,
  body: Record<string, unknown>,
  name: string,
  max?: number,
): string | null | undefined {
  if (!Object.hasOwn(body, name)) return undefined;
  const value = body[name];
  if (value === null) return null;
  if (typeof value !== 'string')
    throw invalidArgument(call, `Invalid Input: ${name}`);
  if (max !== undefined && [...value].length > max)
    throw invalidArgument(
      call,
      `Invalid Input: ${name} is longer than ${max} characters.`,
    );
  return value;
}

/** Read an optional boolean field. `null` reads as false. */
export function booleanField(
  call: Call,
  body: Record<string, unknown>,
  name: string,
): boolean | undefined {
  if (!Object.hasOwn(body, name)) return undefined;
  const value = body[name];
  if (value === null) return false;
  if (typeof value !== 'boolean')
    throw invalidArgument(call, `Invalid Input: ${name}`);
  return value;
}

export const failedPrecondition = (message: string): ApiError =>
  new ApiError(
    directoryError(400, 'failedPrecondition', message, {
      extra: { status: 'FAILED_PRECONDITION' },
    }),
  );

export const duplicate = (): ApiError =>
  new ApiError(directoryError(409, 'duplicate', 'Entity already exists.'));

export const notFound = (what: string): ApiError =>
  new ApiError(directoryError(404, 'notFound', `Resource Not Found: ${what}`));

/** The search delay of the call's domain in scaled milliseconds. */
export function searchDelayMs(call: Call): number {
  return (
    (domainOf(call).record.settings.writes.searchDelaySeconds * 1000) /
    call.scale
  );
}

/** The relation that a list reads: the live table, or its listed view while before-images wait. */
export function listedTable(call: Call, table: LaggedTable): string {
  return listedRelation(
    domainOf(call).db,
    table,
    call.now,
    searchDelayMs(call),
  );
}
