import { createHash } from 'node:crypto';

export class PageTokenError extends Error {
  constructor() {
    super('Invalid page token.');
    this.name = 'PageTokenError';
  }
}

const IGNORED = new Set([
  'pageToken',
  'maxResults',
  'pageSize',
  'fields',
  'prettyPrint',
  'alt',
  'key',
  'quotaUser',
  'userIp',
  '$.xgafv',
  'access_token',
  'callback',
]);

/** A short hash of everything that selects or orders the rows. */
export function fingerprint(
  path: string,
  query: URLSearchParams,
  seededAt: number,
): string {
  const entries = [...query.entries()]
    .filter(([key]) => !IGNORED.has(key))
    .sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    );
  return createHash('sha256')
    .update(JSON.stringify([path, seededAt, entries]))
    .digest('base64url')
    .slice(0, 16);
}

export function encodePageToken(
  fp: string,
  cursor: readonly (string | number)[],
): string {
  return Buffer.from(JSON.stringify({ f: fp, c: cursor })).toString(
    'base64url',
  );
}

export function decodePageToken(
  token: string,
  fp: string,
  length: number,
): (string | number)[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new PageTokenError();
  }
  if (parsed === null || typeof parsed !== 'object') throw new PageTokenError();
  const { f, c } = parsed as { f?: unknown; c?: unknown };
  if (
    f !== fp ||
    !Array.isArray(c) ||
    c.length !== length ||
    !c.every((value) => typeof value === 'string' || typeof value === 'number')
  )
    throw new PageTokenError();
  return c as (string | number)[];
}
