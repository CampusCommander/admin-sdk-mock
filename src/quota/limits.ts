import type { Clock, Timing } from '../clock.ts';
import { directoryError, rpcError } from '../http/errors.ts';
import type { Api, ApiResponse, Call } from '../http/types.ts';
import type { Admission } from '../pipeline.ts';
import type { WriteSettings } from '../settings.ts';
import { QuotaBucket, type BucketSnapshot, type QuotaRules } from './bucket.ts';

export interface QuotaReport {
  buckets: {
    api: string;
    projectId: string;
    subject: string;
    snapshot: BucketSnapshot;
  }[];
  inFlight: { total: number; byMethod: Record<string, number> };
}

export interface Limits {
  admit(call: Call): Admission;
  inFlight(customerId: string): number;
  report(customerId: string): QuotaReport;
  reset(): void;
}

const SERVICE: Record<string, string> = {
  directory: 'admin.googleapis.com',
  chrome: 'chromemanagement.googleapis.com',
};

function quotaError(api: Api, retryAfterMs: number | null): ApiResponse {
  const message = `Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service '${SERVICE[api]}'.`;
  const response =
    api === 'chrome'
      ? rpcError(429, 'RESOURCE_EXHAUSTED', message)
      : directoryError(403, 'userRateLimitExceeded', message, {
          domain: 'usageLimits',
        });
  return retryAfterMs === null
    ? response
    : {
        ...response,
        headers: {
          'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        },
      };
}

function concurrencyError(api: Api, scope: 'method' | 'customer'): ApiResponse {
  if (api === 'chrome')
    return rpcError(429, 'RESOURCE_EXHAUSTED', 'Too many concurrent requests.');
  return scope === 'method'
    ? directoryError(403, 'quotaExceeded', 'Quota exceeded.', {
        domain: 'usageLimits',
      })
    : directoryError(429, 'rateLimitExceeded', 'Rate Limit Exceeded', {
        domain: 'usageLimits',
      });
}

/** Per-second write limits by route ID. */
const WRITE_LIMITS: Readonly<
  Record<string, { key: string; perSecond(writes: WriteSettings): number }>
> = {
  'directory.users.insert': {
    key: 'userCreates',
    perSecond: (writes) => writes.userCreatesPerSecond,
  },
  'directory.orgunits.insert': {
    key: 'orgUnitWrites',
    perSecond: (writes) => writes.orgUnitWritesPerSecond,
  },
  'directory.orgunits.update': {
    key: 'orgUnitWrites',
    perSecond: (writes) => writes.orgUnitWritesPerSecond,
  },
  'directory.orgunits.patch': {
    key: 'orgUnitWrites',
    perSecond: (writes) => writes.orgUnitWritesPerSecond,
  },
};

/** Ruling: Google documents the write limits but not their response. */
const writeLimitError = (): ApiResponse =>
  directoryError(403, 'rateLimitExceeded', 'Rate Limit Exceeded', {
    domain: 'usageLimits',
  });

interface Entry {
  bucket: QuotaBucket;
  signature: string;
  customerId: string;
  api: string;
  projectId: string;
  subject: string;
}

/** Quota buckets per project and subject, plus in-flight caps per customer. */
export function createLimits(deps: { clock: Clock; timing: Timing }): Limits {
  const buckets = new Map<string, Entry>();
  const inFlight = new Map<string, number>();
  const writeCounts = new Map<string, { window: number; count: number }>();
  const bump = (key: string, delta: number) => {
    const next = (inFlight.get(key) ?? 0) + delta;
    if (next <= 0) inFlight.delete(key);
    else inFlight.set(key, next);
  };
  return {
    admit(call) {
      const { access, domain, route } = call;
      if (
        !access ||
        !domain ||
        (route.api !== 'directory' && route.api !== 'chrome')
      )
        return { ok: true, release() {} };
      const settings = domain.record.settings;
      const now = deps.clock.now();
      const customerKey = access.customerId;
      const methodKey = `${access.customerId}|${route.id}`;
      if ((inFlight.get(customerKey) ?? 0) >= settings.concurrency.perCustomer)
        return { ok: false, response: concurrencyError(route.api, 'customer') };
      if ((inFlight.get(methodKey) ?? 0) >= settings.concurrency.perMethod)
        return { ok: false, response: concurrencyError(route.api, 'method') };
      const writeLimit = WRITE_LIMITS[route.id];
      const writeKey = writeLimit
        ? `${access.customerId}|${writeLimit.key}`
        : '';
      const window = Math.floor(now / (1000 / deps.timing.scale));
      const written = writeCounts.get(writeKey);
      const used = written && written.window === window ? written.count : 0;
      if (writeLimit && used >= writeLimit.perSecond(settings.writes))
        return { ok: false, response: writeLimitError() };
      const quota =
        route.api === 'chrome' ? settings.chromeQuota : settings.quota;
      const rules: QuotaRules = {
        perMinute: quota.perMinute,
        ceiling: quota.ceiling,
        heavyRatio: quota.heavyRatio,
        overMinutesToFlag: quota.overMinutesToFlag,
        heavyMinutesToFlag: quota.heavyMinutesToFlag,
        flagMinutes: quota.flagMinutes,
      };
      const minuteMs = 60_000 / deps.timing.scale;
      const key = `${route.api}|${access.customerId}|${access.token.projectId}|${access.subject}`;
      const signature = JSON.stringify([rules, minuteMs]);
      let entry = buckets.get(key);
      if (!entry || entry.signature !== signature) {
        entry = {
          bucket: new QuotaBucket(rules, minuteMs),
          signature,
          customerId: access.customerId,
          api: route.api,
          projectId: access.token.projectId,
          subject: access.subject,
        };
        buckets.set(key, entry);
      }
      if (!entry.bucket.admit(now))
        return {
          ok: false,
          response: quotaError(
            route.api,
            quota.retryAfter ? entry.bucket.retryAfterMs(now) : null,
          ),
        };
      if (writeLimit) writeCounts.set(writeKey, { window, count: used + 1 });
      bump(customerKey, 1);
      bump(methodKey, 1);
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          bump(customerKey, -1);
          bump(methodKey, -1);
        },
      };
    },
    inFlight: (customerId) => inFlight.get(customerId) ?? 0,
    report(customerId) {
      const now = deps.clock.now();
      const byMethod: Record<string, number> = {};
      for (const [key, count] of inFlight)
        if (key.startsWith(`${customerId}|`))
          byMethod[key.slice(customerId.length + 1)] = count;
      return {
        buckets: [...buckets.values()]
          .filter((entry) => entry.customerId === customerId)
          .map((entry) => ({
            api: entry.api,
            projectId: entry.projectId,
            subject: entry.subject,
            snapshot: entry.bucket.snapshot(now),
          })),
        inFlight: { total: inFlight.get(customerId) ?? 0, byMethod },
      };
    },
    reset() {
      buckets.clear();
      writeCounts.clear();
    },
  };
}
