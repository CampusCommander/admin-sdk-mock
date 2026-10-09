import { randomUUID } from 'node:crypto';
import type { Clock, Timing } from '../clock.ts';
import {
  directoryError,
  internalError,
  rpcError,
  transientError,
} from '../http/errors.ts';
import type { Api, ApiResponse, Call, Overrides } from '../http/types.ts';
import type { Random } from '../random.ts';

export type FaultRule =
  | { kind: 'error-rate'; method?: string; rate: number }
  | {
      kind: 'status';
      method?: string;
      status: number;
      reason: string;
      count: number;
    }
  | { kind: 'reset'; method?: string; count: number }
  | { kind: 'hang'; method?: string; ms: number; count: number }
  | { kind: 'revoke-delegation'; clientId: string }
  | { kind: 'remove-scope'; clientId: string; scope: string }
  | { kind: 'demote-subject'; subject: string }
  | { kind: 'remove-entity'; entityId: string };

export interface StoredFault {
  id: string;
  rule: FaultRule;
  remaining: number | null;
}

export class FaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaultError';
  }
}

export interface Faults extends Overrides {
  add(customerId: string, input: unknown): string;
  list(customerId: string): StoredFault[];
  clear(customerId: string): void;
  before(call: Call): Promise<ApiResponse | 'reset' | undefined>;
}

const FIELDS: Record<FaultRule['kind'], readonly string[]> = {
  'error-rate': ['kind', 'method', 'rate'],
  status: ['kind', 'method', 'status', 'reason', 'count'],
  reset: ['kind', 'method', 'count'],
  hang: ['kind', 'method', 'ms', 'count'],
  'revoke-delegation': ['kind', 'clientId'],
  'remove-scope': ['kind', 'clientId', 'scope'],
  'demote-subject': ['kind', 'subject'],
  'remove-entity': ['kind', 'entityId'],
};

const MESSAGES: Record<string, string> = {
  backendError: 'Backend Error',
  quotaExceeded: 'Quota exceeded.',
  rateLimitExceeded: 'Rate Limit Exceeded',
  userRateLimitExceeded: 'User Rate Limit Exceeded',
  forbidden: 'Not Authorized to access this resource/api',
  notFound: 'Not Found',
};
const USAGE_LIMITS = new Set([
  'quotaExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);

function check(condition: boolean, message: string): void {
  if (!condition) throw new FaultError(message);
}

const wholeNumber = (value: unknown, min: number, max: number) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

function validate(input: unknown): FaultRule {
  check(
    input !== null && typeof input === 'object' && !Array.isArray(input),
    'A fault must be an object.',
  );
  const rule = input as Record<string, unknown>;
  const kind = rule.kind as FaultRule['kind'];
  check(
    typeof kind === 'string' && Object.hasOwn(FIELDS, kind),
    'Unknown fault kind.',
  );
  for (const key of Object.keys(rule))
    check(FIELDS[kind].includes(key), `Unknown fault field: ${key}.`);
  if ('method' in rule)
    check(
      typeof rule.method === 'string' && rule.method.length > 0,
      'method must be a route ID.',
    );
  if ('count' in rule || ['status', 'reset', 'hang'].includes(kind))
    check(
      wholeNumber(rule.count, 1, 1_000_000),
      'count must be a whole number from 1 to 1000000.',
    );
  switch (kind) {
    case 'error-rate':
      check(
        typeof rule.rate === 'number' && rule.rate >= 0 && rule.rate <= 1,
        'rate must be from 0 to 1.',
      );
      break;
    case 'status':
      check(
        wholeNumber(rule.status, 400, 599),
        'status must be from 400 to 599.',
      );
      check(
        typeof rule.reason === 'string' &&
          rule.reason.length > 0 &&
          rule.reason.length <= 64,
        'reason must be 1 to 64 characters.',
      );
      break;
    case 'hang':
      check(
        wholeNumber(rule.ms, 1, 600_000),
        'ms must be a whole number from 1 to 600000.',
      );
      break;
    case 'revoke-delegation':
    case 'remove-scope':
      check(
        typeof rule.clientId === 'string' && /^\d{1,32}$/.test(rule.clientId),
        'clientId must be numeric.',
      );
      if (kind === 'remove-scope')
        check(
          typeof rule.scope === 'string' &&
            rule.scope.startsWith('https://www.googleapis.com/auth/'),
          'scope must be a Google scope URL.',
        );
      break;
    case 'demote-subject':
      check(
        typeof rule.subject === 'string' && rule.subject.includes('@'),
        'subject must be an email address.',
      );
      break;
    case 'remove-entity':
      check(
        typeof rule.entityId === 'string' &&
          rule.entityId.length > 0 &&
          rule.entityId.length <= 256,
        'entityId must be 1 to 256 characters.',
      );
      break;
  }
  return rule as unknown as FaultRule;
}

function statusResponse(api: Api, status: number, reason: string): ApiResponse {
  if (api === 'chrome')
    return rpcError(status, reason, `Injected fault: ${reason}`);
  return directoryError(status, reason, MESSAGES[reason] ?? reason, {
    domain: USAGE_LIMITS.has(reason) ? 'usageLimits' : 'global',
  });
}

export function createFaults(deps: {
  clock: Clock;
  timing: Timing;
  random: Random;
}): Faults {
  const store = new Map<string, StoredFault[]>();
  const rulesOf = (customerId: string) => store.get(customerId) ?? [];
  const ofKind = <K extends FaultRule['kind']>(customerId: string, kind: K) =>
    rulesOf(customerId)
      .map((fault) => fault.rule)
      .filter(
        (rule): rule is Extract<FaultRule, { kind: K }> => rule.kind === kind,
      );
  return {
    add(customerId, input) {
      const rule = validate(input);
      const id = randomUUID();
      const remaining = 'count' in rule ? rule.count : null;
      store.set(customerId, [...rulesOf(customerId), { id, rule, remaining }]);
      return id;
    },
    list: (customerId) => rulesOf(customerId).map((fault) => ({ ...fault })),
    clear(customerId) {
      store.delete(customerId);
    },
    async before(call) {
      const customerId = call.access?.customerId;
      if (!customerId) return undefined;
      for (const fault of rulesOf(customerId)) {
        const { rule } = fault;
        if (!(
          'method' in rule ||
          ['error-rate', 'status', 'reset', 'hang'].includes(rule.kind)
        ))
          continue;
        if ('method' in rule && rule.method && rule.method !== call.route.id)
          continue;
        switch (rule.kind) {
          case 'status':
            if (fault.remaining! > 0) {
              fault.remaining!--;
              return statusResponse(call.route.api, rule.status, rule.reason);
            }
            break;
          case 'reset':
            if (fault.remaining! > 0) {
              fault.remaining!--;
              return 'reset';
            }
            break;
          case 'hang':
            if (fault.remaining! > 0) {
              fault.remaining!--;
              await deps.clock.sleep(rule.ms / deps.timing.scale);
            }
            break;
          case 'error-rate':
            if (deps.random.chance(rule.rate))
              return deps.random.chance(0.5)
                ? internalError(call.route.api)
                : transientError(call.route.api);
            break;
        }
      }
      return undefined;
    },
    grant(customerId, clientId, scopes) {
      if (
        ofKind(customerId, 'revoke-delegation').some(
          (rule) => rule.clientId === clientId,
        )
      )
        return undefined;
      const removed = new Set(
        ofKind(customerId, 'remove-scope')
          .filter((rule) => rule.clientId === clientId)
          .map((rule) => rule.scope),
      );
      return scopes?.filter((scope) => !removed.has(scope));
    },
    isAdmin(customerId, email, isAdmin) {
      return (
        isAdmin &&
        !ofKind(customerId, 'demote-subject').some(
          (rule) => rule.subject.toLowerCase() === email.toLowerCase(),
        )
      );
    },
    hidden(customerId) {
      return new Set(
        ofKind(customerId, 'remove-entity').map((rule) => rule.entityId),
      );
    },
  };
}
