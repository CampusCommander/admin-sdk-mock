import type { DatabaseSync } from 'node:sqlite';
import type { ResolvedSpec } from '../seed/spec.ts';
import type { StoredDomain, StoredToken } from '../store/registry.ts';

export type Api = 'oauth' | 'directory' | 'chrome' | 'batch';

export interface ApiRequest {
  method: string;
  /** Lower-case host name without a port. */
  host: string;
  /** The encoded URL path. */
  path: string;
  query: URLSearchParams;
  /** Lower-case header names. */
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface ApiResponse {
  status: number;
  /** A JSON body. `finalize` serializes it into `raw`. */
  body?: unknown;
  /** The serialized body. */
  raw?: string;
  headers?: Record<string, string>;
  /** Items returned, for the latency model. */
  items?: number;
  /** Rows scanned by a filter, for the latency model. */
  scanned?: number;
}

export interface Access {
  token: StoredToken;
  customerId: string;
  subject: string;
  isAdmin: boolean;
}

export interface OpenDomain {
  customerId: string;
  record: StoredDomain;
  spec: ResolvedSpec;
  db: DatabaseSync;
}

/** State changes that faults apply on top of stored data. */
export interface Overrides {
  grant(
    customerId: string,
    clientId: string,
    scopes: readonly string[] | undefined,
  ): readonly string[] | undefined;
  isAdmin(customerId: string, email: string, isAdmin: boolean): boolean;
  /** Device and user IDs that requests must not see. */
  hidden(customerId: string): ReadonlySet<string>;
}

const NOTHING: ReadonlySet<string> = new Set();

export const NO_OVERRIDES: Overrides = {
  grant: (_customerId, _clientId, scopes) => scopes,
  isAdmin: (_customerId, _email, isAdmin) => isAdmin,
  hidden: () => NOTHING,
};

export interface Call {
  route: Route;
  params: Readonly<Record<string, string>>;
  request: ApiRequest;
  access: Access | null;
  domain: OpenDomain | null;
  batchPart: boolean;
  overrides: Overrides;
  /** The time the handler starts, in epoch milliseconds. Writes stamp it on before-images. */
  now: number;
  /** The time scale at dispatch. Durations divide by it. */
  scale: number;
  /** Run one batch part through the full pipeline. */
  dispatchPart(request: ApiRequest): Promise<ApiResponse>;
}

export interface Route {
  id: string;
  api: Api;
  hosts: readonly string[];
  methods: readonly string[];
  pattern: RegExp;
  /** The token needs at least one of these scopes. */
  scopes: readonly string[];
  /** The delegated subject must be a super administrator. */
  admin: boolean;
  /** Writes use the write latency costs. */
  write?: boolean;
  handler(call: Call): ApiResponse | Promise<ApiResponse>;
}

export interface Authenticator {
  authenticate(
    request: ApiRequest,
    route: Route,
  ): { access: Access; domain: OpenDomain } | ApiResponse;
}
