export interface QuotaSettings {
  perMinute: number;
  ceiling: number;
  heavyRatio: number;
  overMinutesToFlag: number;
  heavyMinutesToFlag: number;
  flagMinutes: number;
  retryAfter: boolean;
}

export interface LatencySettings {
  roundTripMedianMs: number;
  roundTripP99Ms: number;
  bytesPerSecond: number;
  baseMs: number;
  perItemMs: number;
  scanPer10kRowsMs: number;
  loadThreshold: number;
  loadPercentPerRequest: number;
  batchParallelism: number;
  batchPartMs: number;
  capMs: number;
  writeBaseMs: number;
  perDeviceWriteMs: number;
}

export interface WriteSettings {
  searchDelaySeconds: number;
  commandExpirySeconds: number;
  userCreatesPerSecond: number;
  orgUnitWritesPerSecond: number;
}

export interface DomainSettings {
  quota: QuotaSettings;
  chromeQuota: QuotaSettings;
  concurrency: { perMethod: number; perCustomer: number };
  latency: LatencySettings;
  telemetry: { recentReports: number };
  writes: WriteSettings;
}

const QUOTA: QuotaSettings = {
  perMinute: 2400,
  ceiling: 1.25,
  heavyRatio: 1.125,
  overMinutesToFlag: 30,
  heavyMinutesToFlag: 10,
  flagMinutes: 60,
  retryAfter: false,
};

export const DEFAULT_SETTINGS: DomainSettings = Object.freeze({
  quota: QUOTA,
  chromeQuota: QUOTA,
  concurrency: { perMethod: 40, perCustomer: 120 },
  latency: {
    roundTripMedianMs: 80,
    roundTripP99Ms: 400,
    bytesPerSecond: 8_000_000,
    baseMs: 150,
    perItemMs: 3,
    scanPer10kRowsMs: 20,
    loadThreshold: 20,
    loadPercentPerRequest: 2,
    batchParallelism: 10,
    batchPartMs: 40,
    capMs: 2000,
    writeBaseMs: 250,
    perDeviceWriteMs: 10,
  },
  telemetry: { recentReports: 1 },
  writes: {
    searchDelaySeconds: 300,
    commandExpirySeconds: 432_000,
    userCreatesPerSecond: 10,
    orgUnitWritesPerSecond: 1,
  },
}) as DomainSettings;

/** Fill any key that a stored row lacks from the defaults. */
export function withDefaults(stored: unknown): DomainSettings {
  const fill = (base: unknown, value: unknown): unknown => {
    if (typeof base !== 'object' || base === null) return value ?? base;
    const given =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return Object.fromEntries(
      Object.entries(base).map(([key, inner]) => [
        key,
        fill(inner, given[key]),
      ]),
    );
  };
  return fill(DEFAULT_SETTINGS, stored) as DomainSettings;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

function merge(base: unknown, patch: unknown, path: string): unknown {
  if (patch === undefined) return base;
  if (typeof base === 'object' && base !== null) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
      throw new SettingsError(`${path} must be an object.`);
    const out: Record<string, unknown> = {
      ...(base as Record<string, unknown>),
    };
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(out, key))
        throw new SettingsError(`Unknown setting: ${path}.${key}.`);
      out[key] = merge(out[key], value, `${path}.${key}`);
    }
    return out;
  }
  if (typeof base === 'boolean') {
    if (typeof patch !== 'boolean')
      throw new SettingsError(`${path} must be true or false.`);
    return patch;
  }
  if (typeof patch !== 'number' || !Number.isFinite(patch) || patch < 0)
    throw new SettingsError(`${path} must be a non-negative number.`);
  return patch;
}

function check(condition: boolean, message: string) {
  if (!condition) throw new SettingsError(message);
}

function validateQuota(quota: QuotaSettings, path: string) {
  check(quota.perMinute >= 1, `${path}.perMinute must be 1 or more.`);
  check(quota.ceiling >= 1, `${path}.ceiling must be 1 or more.`);
  check(
    quota.heavyRatio >= 1 && quota.heavyRatio <= quota.ceiling,
    `${path}.heavyRatio must be from 1 to the ceiling.`,
  );
  for (const key of [
    'overMinutesToFlag',
    'heavyMinutesToFlag',
    'flagMinutes',
  ] as const)
    check(
      Number.isInteger(quota[key]) && quota[key] >= 1 && quota[key] <= 60,
      `${path}.${key} must be a whole number from 1 to 60.`,
    );
}

/** Apply a partial settings patch and validate the result. */
export function mergeSettings(
  base: DomainSettings,
  patch: unknown,
): DomainSettings {
  const merged = merge(base, patch, 'settings') as DomainSettings;
  validateQuota(merged.quota, 'settings.quota');
  validateQuota(merged.chromeQuota, 'settings.chromeQuota');
  check(
    merged.concurrency.perMethod >= 1 && merged.concurrency.perCustomer >= 1,
    'Concurrency caps must be 1 or more.',
  );
  const latency = merged.latency;
  check(latency.bytesPerSecond > 0, 'latency.bytesPerSecond must be above 0.');
  check(
    latency.roundTripP99Ms >= latency.roundTripMedianMs,
    'latency.roundTripP99Ms must be at least the median.',
  );
  check(
    Number.isInteger(latency.batchParallelism) && latency.batchParallelism >= 1,
    'latency.batchParallelism must be a whole number of 1 or more.',
  );
  check(
    Number.isInteger(merged.telemetry.recentReports) &&
      merged.telemetry.recentReports >= 1,
    'telemetry.recentReports must be a whole number of 1 or more.',
  );
  const writes = merged.writes;
  check(
    writes.commandExpirySeconds >= 1,
    'writes.commandExpirySeconds must be 1 or more.',
  );
  for (const key of ['userCreatesPerSecond', 'orgUnitWritesPerSecond'] as const)
    check(
      Number.isInteger(writes[key]) && writes[key] >= 1,
      `writes.${key} must be a whole number of 1 or more.`,
    );
  return merged;
}
