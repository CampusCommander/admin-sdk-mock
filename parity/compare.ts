export type Shape = string | Shape[] | { [key: string]: Shape };

function merge(a: Shape | undefined, b: Shape): Shape {
  if (a === undefined) return b;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === 0 ? b : b.length === 0 ? a : [merge(a[0], b[0])];
  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const out: Record<string, Shape> = { ...a };
    for (const [key, value] of Object.entries(b))
      out[key] = merge(out[key], value);
    return Object.fromEntries(
      Object.entries(out).sort(([x], [y]) => (x < y ? -1 : 1)),
    );
  }
  return a === b ? a : `${String(a)}|${String(b)}`;
}

/** The keys and value types of a JSON value, without the values. */
export function shapeOf(value: unknown): Shape {
  if (Array.isArray(value)) {
    const merged = value
      .map(shapeOf)
      .reduce<Shape | undefined>((all, item) => merge(all, item), undefined);
    return merged === undefined ? [] : [merged];
  }
  if (value === null) return 'null';
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, shapeOf(item)]),
    );
  return typeof value;
}

/** Paths in `expected` that `actual` lacks. */
export function missingPaths(
  expected: Shape,
  actual: Shape,
  path = '$',
): string[] {
  if (Array.isArray(expected))
    return Array.isArray(actual) && expected.length > 0 && actual.length > 0
      ? missingPaths(expected[0], actual[0], `${path}[]`)
      : [];
  if (typeof expected !== 'object') return [];
  if (typeof actual !== 'object' || Array.isArray(actual)) return [path];
  return Object.entries(expected).flatMap(([key, value]) =>
    key in actual
      ? missingPaths(value, actual[key], `${path}.${key}`)
      : [`${path}.${key}`],
  );
}

/** The fields of an error body that the mock must reproduce. */
export function errorSignature(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object') return { raw: typeof body };
  const value = body as { error?: unknown; error_description?: unknown };
  if (typeof value.error === 'string')
    return { error: value.error, description: value.error_description };
  const error = (value.error ?? {}) as Record<string, unknown>;
  const first = (Array.isArray(error.errors) ? error.errors[0] : undefined) as
    Record<string, unknown> | undefined;
  const signature: Record<string, unknown> = {
    code: error.code,
    message: error.message,
    status: error.status,
    reason: first?.reason,
    domain: first?.domain,
    itemMessage: first?.message,
    location: first?.location,
    locationType: first?.locationType,
    keys: Object.keys(error).sort().join(','),
  };
  return Object.fromEntries(
    Object.entries(signature).filter(([, item]) => item !== undefined),
  );
}

const CUSTOMER = /\bC[0-9A-Za-z]{8}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Replace customer IDs, email addresses, and the given patterns in every string. */
export function redact(value: unknown, patterns: readonly RegExp[]): unknown {
  if (typeof value === 'string') {
    let text = value.replace(CUSTOMER, '<customer>').replace(EMAIL, '<email>');
    for (const pattern of patterns) text = text.replace(pattern, '<redacted>');
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, patterns));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, patterns)]),
    );
  return value;
}

export interface Observation {
  status: number;
  body: unknown;
}

export interface ProbeResult {
  probe: string;
  google: { status: number; shape?: Shape; error?: Record<string, unknown> };
  mock: { status: number; shape?: Shape; error?: Record<string, unknown> };
  mismatches: string[];
  notes: string[];
}

const ok = (status: number) => status >= 200 && status < 300;

export function compareObservations(
  probe: string,
  google: Observation,
  mock: Observation,
): ProbeResult {
  const mismatches: string[] = [];
  const notes: string[] = [];
  if (google.status !== mock.status)
    mismatches.push(`status ${google.status} != ${mock.status}`);
  const side = (observation: Observation) =>
    ok(observation.status)
      ? { status: observation.status, shape: shapeOf(observation.body) }
      : { status: observation.status, error: errorSignature(observation.body) };
  const g = side(google);
  const m = side(mock);
  if (g.shape && m.shape) {
    mismatches.push(
      ...missingPaths(g.shape, m.shape).map((path) => `missing ${path}`),
    );
    notes.push(
      ...missingPaths(m.shape, g.shape).map((path) => `extra ${path}`),
    );
  } else if (g.error && m.error) {
    for (const key of new Set([
      ...Object.keys(g.error),
      ...Object.keys(m.error),
    ]))
      if (
        key !== 'keys' &&
        JSON.stringify(g.error[key]) !== JSON.stringify(m.error[key])
      )
        mismatches.push(
          `${key} ${JSON.stringify(g.error[key])} != ${JSON.stringify(m.error[key])}`,
        );
    if (g.error.keys !== m.error.keys)
      notes.push(
        `error keys ${String(g.error.keys)} vs ${String(m.error.keys)}`,
      );
  }
  return { probe, google: g, mock: m, mismatches, notes };
}
