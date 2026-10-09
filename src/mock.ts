import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { createAuthenticator } from './auth/access.ts';
import { ensureCertificates, type Certificates } from './ca.ts';
import { systemClock, type Clock, type Timing } from './clock.ts';
import { createDomains, type Domains } from './domains.ts';
import {
  ApiError,
  directoryError,
  internalError,
  notFoundPage,
  rpcError,
  transientError,
} from './http/errors.ts';
import { createFaults, type Faults } from './faults/faults.ts';
import { matchRoute } from './http/router.ts';
import {
  type Access,
  type ApiRequest,
  type ApiResponse,
  type Authenticator,
  type Call,
  type OpenDomain,
  type Overrides,
  type Route,
} from './http/types.ts';
import { createDelays } from './latency/delays.ts';
import { type Pipeline } from './pipeline.ts';
import { createLimits, type Limits } from './quota/limits.ts';
import { createRandom, type Random } from './random.ts';
import { buildRoutes } from './routes.ts';
import {
  applyFields,
  FieldsError,
  parseFields,
  unknownField,
} from './store/fields.ts';
import { openRegistry, type Registry } from './store/registry.ts';

export interface MockOptions {
  dataDir: string;
  clock?: Clock;
  timing?: Timing;
  random?: Random;
  /** Replace the Google routes. Tests use this. */
  routes?: readonly Route[];
}

export interface Mock {
  readonly dataDir: string;
  readonly registry: Registry;
  readonly domains: Domains;
  readonly certificates: Certificates;
  readonly clock: Clock;
  readonly timing: Timing;
  readonly random: Random;
  readonly limits: Limits;
  readonly faults: Faults;
  readonly routes: Route[];
  pipeline: Pipeline;
  overrides: Overrides;
  authenticator: Authenticator;
  dispatch(
    request: ApiRequest,
    batchPart?: boolean,
  ): Promise<ApiResponse | 'reset'>;
  handleGoogle(request: IncomingMessage, response: ServerResponse): void;
  listenGoogle(port: number, host?: string): Promise<https.Server>;
  close(): void;
}

export const BODY_LIMIT = 32 * 1024 * 1024;

/** Apply `fields` to a 2xx JSON body and serialize the body. */
export function finalize(
  response: ApiResponse,
  request: ApiRequest,
  route: Route | null,
): ApiResponse {
  if (response.raw !== undefined) return response;
  if (response.body === undefined) return { ...response, raw: '' };
  let body: unknown = response.body;
  const fields = request.query.get('fields');
  if (fields && response.status >= 200 && response.status < 300) {
    try {
      const tree = parseFields(fields);
      const unknown = unknownField(tree);
      if (unknown !== null)
        throw new FieldsError(`Invalid field selection ${unknown}`);
      body = applyFields(body, tree);
    } catch (error) {
      if (!(error instanceof FieldsError)) throw error;
      return finalize(
        route?.api === 'chrome'
          ? rpcError(400, 'INVALID_ARGUMENT', error.message)
          : directoryError(400, 'invalidParameter', error.message, {
              item: { location: 'fields', locationType: 'parameter' },
              extra: { status: 'INVALID_ARGUMENT' },
            }),
        request,
        route,
      );
    }
  }
  const pretty = request.query.get('prettyPrint') !== 'false';
  return {
    ...response,
    body,
    raw: JSON.stringify(body, null, pretty ? 2 : undefined),
  };
}

export function createMock(options: MockOptions): Mock {
  mkdirSync(options.dataDir, { recursive: true });
  const registry = openRegistry(join(options.dataDir, 'registry.sqlite'));
  const certificates = ensureCertificates(join(options.dataDir, 'ca'));
  const domains = createDomains(options.dataDir, registry);
  const servers = new Set<https.Server>();
  const clock = options.clock ?? systemClock;
  const timing = options.timing ?? { scale: 1, delays: true };
  const limits = createLimits({ clock, timing });
  const random = options.random ?? createRandom(`mock/${Date.now()}`);
  const delays = createDelays({ clock, timing, random, limits });
  const faults = createFaults({
    clock,
    timing,
    random,
    methods: () =>
      mock.routes
        .filter((route) => route.api === 'directory' || route.api === 'chrome')
        .map((route) => route.id),
  });

  const mock: Mock = {
    dataDir: options.dataDir,
    registry,
    domains,
    certificates,
    clock,
    timing,
    random,
    limits,
    faults,
    routes: [],
    pipeline: {
      before: (call) => faults.before(call),
      admit: (call) => limits.admit(call),
      delay: (call, response) => delays.delay(call, response),
    },
    overrides: faults,
    authenticator: {
      authenticate: () =>
        directoryError(401, 'authError', 'Invalid Credentials'),
    },

    async dispatch(request, batchPart = false) {
      const match = matchRoute(mock.routes, request);
      if (!match) return finalize(notFoundPage(request.path), request, null);
      const { route, params } = match;
      let access: Access | null = null;
      let domain: OpenDomain | null = null;
      if (route.api === 'directory' || route.api === 'chrome') {
        const result = mock.authenticator.authenticate(request, route);
        if (!('access' in result)) return finalize(result, request, route);
        access = result.access;
        domain = result.domain;
      }
      const call: Call = {
        route,
        params,
        request,
        access,
        domain,
        batchPart,
        overrides: mock.overrides,
        dispatchPart: async (part) => {
          const answer = await mock.dispatch(part, true);
          return answer === 'reset'
            ? finalize(transientError('directory'), part, null)
            : answer;
        },
      };
      const fault = await mock.pipeline.before(call);
      if (fault === 'reset')
        return batchPart
          ? finalize(transientError(route.api), request, route)
          : 'reset';
      if (fault) return finalize(fault, request, route);
      const admission = mock.pipeline.admit(call);
      if (!admission.ok) return finalize(admission.response, request, route);
      try {
        let response: ApiResponse;
        try {
          response = await route.handler(call);
        } catch (error) {
          if (error instanceof ApiError) response = error.response;
          else {
            console.error(error);
            response = internalError(route.api);
          }
        }
        response = finalize(response, request, route);
        await mock.pipeline.delay(call, response);
        return response;
      } finally {
        admission.release();
      }
    },

    handleGoogle(incoming, outgoing) {
      void (async () => {
        const host = (incoming.headers.host ?? '')
          .replace(/:\d+$/, '')
          .toLowerCase();
        const url = new URL(incoming.url ?? '/', 'https://mock.invalid');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > BODY_LIMIT) {
            outgoing.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(incoming.headers))
          if (value !== undefined)
            headers[key] = Array.isArray(value) ? value.join(', ') : value;
        const result = await mock.dispatch({
          method: incoming.method ?? 'GET',
          host,
          path: url.pathname,
          query: url.searchParams,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (result === 'reset') {
          incoming.socket.destroy();
          return;
        }
        outgoing.writeHead(result.status, {
          'content-type': 'application/json; charset=UTF-8',
          ...result.headers,
        });
        outgoing.end(result.raw ?? '');
      })().catch((error: unknown) => {
        console.error(error);
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      });
    },

    async listenGoogle(port, host = '0.0.0.0') {
      const server = https.createServer(
        { cert: certificates.serverCert, key: certificates.serverKey },
        (request, response) => mock.handleGoogle(request, response),
      );
      servers.add(server);
      server.listen(port, host);
      await once(server, 'listening');
      return server;
    },

    close() {
      for (const server of servers) {
        server.close();
        server.closeAllConnections();
      }
      domains.closeAll();
      registry.close();
    },
  };
  mock.authenticator = createAuthenticator(mock);
  mock.routes.push(...(options.routes ?? buildRoutes(mock)));
  return mock;
}
