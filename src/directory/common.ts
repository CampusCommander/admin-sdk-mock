import { createHash } from 'node:crypto';
import {
  ApiError,
  directoryError,
  notAuthorized,
  rpcError,
} from '../http/errors.ts';
import type { Call, OpenDomain } from '../http/types.ts';

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
  throw new ApiError(notAuthorized(call.route.api));
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
