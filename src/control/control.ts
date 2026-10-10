import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccountError, issueServiceAccount } from '../auth/accounts.ts';
import { MAX_SCALE } from '../clock.ts';
import { scopesFor } from '../config/config.ts';
import { DomainError } from '../domains.ts';
import { FaultError } from '../faults/faults.ts';
import type { Mock } from '../mock.ts';
import type { ServerInfo } from '../server.ts';
import { settleDueCommands } from '../directory/command-effects.ts';
import { endGroupDelays } from '../store/group-lookup.ts';
import { flushLag, pendingLag } from '../store/lag.ts';
import { row } from '../store/sqlite.ts';
import { findUser } from '../store/user-lookup.ts';

const BODY_LIMIT = 1024 * 1024;

class ControlError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ControlError';
    this.status = status;
  }
}

const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'admin-sdk-mock',
]);

/** Refuse requests that a web page could forge with a rebound or foreign Host. */
function checkHost(request: IncomingMessage): void {
  const host = (request.headers.host ?? '').toLowerCase();
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.replace(/:\d*$/, '');
  if (!ALLOWED_HOSTS.has(name))
    throw new ControlError(403, 'The Host header is not allowed.');
}

function carriesBody(request: IncomingMessage): boolean {
  const length = request.headers['content-length'];
  return (
    request.headers['transfer-encoding'] !== undefined ||
    (length !== undefined && length !== '0')
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The client ID and project that tokens minted by the control API carry. */
const CONTROL_CLIENT_ID = '100000000000000000000';
const CONTROL_PROJECT_ID = 'admin-sdk-mock-control';
const MAX_TOKEN_SECONDS = 3600;

/** Read the JSON body. It must be an object unless the caller validates it. */
async function readJson(
  request: IncomingMessage,
  anyValue = false,
): Promise<Record<string, unknown>> {
  const value = await readJsonValue(request);
  if (!anyValue && !isPlainObject(value))
    throw new ControlError(400, 'The request body must be a JSON object.');
  return value as Record<string, unknown>;
}

async function readJsonValue(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT)
      throw new ControlError(413, 'The request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ControlError(400, 'The request body is not valid JSON.');
  }
}

function send(
  response: ServerResponse,
  status: number,
  body?: unknown,
  type = 'application/json',
) {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': type });
  response.end(
    type === 'application/json'
      ? `${JSON.stringify(body, null, 2)}\n`
      : String(body),
  );
}

/** The control API. It binds to loopback or the container network only. */
export function createControlHandler(
  mock: Mock,
  options: { info?: () => ServerInfo } = {},
) {
  const domainOrThrow = (id: string) => {
    const domain = mock.domains.get(id);
    if (!domain) throw new ControlError(404, `Domain ${id} does not exist.`);
    return domain;
  };

  const countsOf = (customerId: string) => {
    const domain = mock.domains.get(customerId);
    const count = (table: string) =>
      domain
        ? Number(
            row<{ n: number }>(
              domain.db.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
            )?.n,
          )
        : 0;
    return {
      orgUnits: count('orgunits'),
      users: count('users'),
      devices: count('devices'),
      groups: count('groups'),
      memberships: count('group_members'),
      pendingWrites: domain
        ? pendingLag(
            domain.db,
            mock.clock.now(),
            (domain.record.settings.writes.searchDelaySeconds * 1000) /
              mock.timing.scale,
          )
        : 0,
    };
  };

  /** Mint an access token for a domain user without the OAuth token exchange. */
  const mintToken = (
    customerId: string,
    body: Record<string, unknown>,
  ): Record<string, unknown> => {
    const domain = domainOrThrow(customerId);
    const named = body.subject ?? `admin@${domain.spec.primaryDomain}`;
    const user = typeof named === 'string' ? findUser(domain.db, named) : null;
    if (!user)
      throw new ControlError(400, 'subject must name a user of the domain.');
    // Store the primary email, so faults and quotas match a token minted by alias or ID.
    const subject = user.primary_email;
    const words = body.scopes ?? 'read-write';
    if (
      !(words === 'read' || words === 'read-write') &&
      !(
        Array.isArray(words) &&
        words.every((scope) => typeof scope === 'string')
      )
    )
      throw new ControlError(
        400,
        'scopes must be read, read-write, or a list of scope strings.',
      );
    const ttl = body.ttlSeconds ?? MAX_TOKEN_SECONDS;
    if (
      typeof ttl !== 'number' ||
      !Number.isInteger(ttl) ||
      ttl < 1 ||
      ttl > MAX_TOKEN_SECONDS
    )
      throw new ControlError(
        400,
        `ttlSeconds must be a whole number from 1 to ${MAX_TOKEN_SECONDS}.`,
      );
    const scopes = scopesFor(words as 'read' | 'read-write' | string[]);
    const token = `ya29.mock.${randomUUID()}`;
    mock.registry.saveToken({
      token,
      clientId: CONTROL_CLIENT_ID,
      projectId: CONTROL_PROJECT_ID,
      subject,
      customerId,
      scopes,
      expiresAt: mock.clock.now() + ttl * 1000,
    });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ttl,
      scope: scopes.join(' '),
    };
  };

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    checkHost(request);
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://control.invalid').pathname;
    let parts: string[];
    try {
      parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new ControlError(400, 'The path has a malformed percent-escape.');
    }
    if (
      ['POST', 'PUT', 'DELETE'].includes(method) &&
      carriesBody(request) &&
      !/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')
    )
      throw new ControlError(415, 'The body must be application/json.');

    if (method === 'GET' && path === '/health')
      return send(response, 200, {
        status: 'ok',
        domains: mock.domains.list().length,
      });
    if (method === 'GET' && path === '/info') {
      if (!options.info) throw new ControlError(404, 'Not found.');
      return send(response, 200, options.info());
    }
    if (method === 'GET' && path === '/ca.pem')
      return send(
        response,
        200,
        mock.certificates.caCert,
        'application/x-pem-file',
      );
    if (path === '/clock') {
      if (method === 'PUT') {
        const body = await readJson(request);
        const { scale, delays } = body;
        if (
          scale !== undefined &&
          (typeof scale !== 'number' || scale < 1 || scale > MAX_SCALE)
        )
          throw new ControlError(
            400,
            `scale must be a number from 1 to ${MAX_SCALE}.`,
          );
        if (delays !== undefined && typeof delays !== 'boolean')
          throw new ControlError(400, 'delays must be true or false.');
        if (scale !== undefined) {
          if (scale !== mock.timing.scale) mock.limits.reset();
          mock.timing.scale = scale;
        }
        if (delays !== undefined) mock.timing.delays = delays;
      } else if (method !== 'GET') throw new ControlError(404, 'Not found.');
      return send(response, 200, mock.timing);
    }
    if (parts[0] !== 'domains') throw new ControlError(404, 'Not found.');

    if (parts.length === 1) {
      if (method === 'GET')
        return send(
          response,
          200,
          mock.domains.list().map((record) => ({
            ...record,
            counts: countsOf(record.customerId),
          })),
        );
      if (method === 'POST') {
        const { domain, result } = mock.domains.create(
          await readJson(request, true),
          mock.clock.now(),
        );
        return send(response, 201, {
          customerId: domain.customerId,
          primaryDomain: domain.spec.primaryDomain,
          studentDomain: domain.spec.studentDomain,
          aliasDomain: domain.spec.aliasDomain,
          districtName: domain.spec.districtName,
          adminEmail: result.adminEmail,
          counts: result.counts,
          durationMs: result.durationMs,
        });
      }
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (method === 'GET')
        return send(response, 200, domainOrThrow(id).record);
      if (method === 'DELETE') {
        mock.faults.clear(id);
        mock.domains.delete(id);
        return send(response, 204);
      }
    }
    if (parts.length === 3) {
      domainOrThrow(id);
      switch (`${method} ${parts[2]}`) {
        case 'POST reset':
          return send(response, 200, mock.domains.reset(id, mock.clock.now()));
        case 'POST service-accounts': {
          const body = await readJson(request);
          if (
            body.projectId !== undefined &&
            typeof body.projectId !== 'string'
          )
            throw new ControlError(400, 'projectId must be a string.');
          return send(
            response,
            201,
            issueServiceAccount(mock.registry, id, body.projectId),
          );
        }
        case 'POST tokens':
          return send(response, 200, mintToken(id, await readJson(request)));
        case 'PUT settings':
          return send(
            response,
            200,
            mock.domains.updateSettings(id, await readJson(request)),
          );
        case 'GET quota':
          return send(response, 200, mock.limits.report(id));
        case 'GET faults':
          return send(response, 200, mock.faults.list(id));
        case 'POST faults':
          return send(response, 201, {
            id: mock.faults.add(id, await readJson(request)),
          });
        case 'DELETE faults':
          mock.faults.clear(id);
          return send(response, 204);
      }
    }
    if (
      parts.length === 4 &&
      parts[2] === 'index' &&
      parts[3] === 'flush' &&
      method === 'POST'
    ) {
      const domain = domainOrThrow(id);
      const now = mock.clock.now();
      const writes = domain.record.settings.writes;
      const scale = mock.timing.scale;
      settleDueCommands(domain.db, now, 0);
      const flushed = flushLag(domain.db);
      const delaysEnded = endGroupDelays(domain.db, {
        readyAfter: now - (writes.groupReadySeconds * 1000) / scale,
        nestingAfter: now - (writes.nestingDelaySeconds * 1000) / scale,
      });
      return send(response, 200, { flushed, delaysEnded });
    }
    if (parts.length === 4 && parts[2] === 'delegation' && method === 'PUT') {
      domainOrThrow(id);
      const body = await readJson(request);
      if (
        !Array.isArray(body.scopes) ||
        !body.scopes.every(
          (scope) =>
            typeof scope === 'string' &&
            scope.startsWith('https://www.googleapis.com/auth/'),
        )
      )
        throw new ControlError(
          400,
          'scopes must be an array of Google scope URLs.',
        );
      mock.registry.setGrant(id, parts[3], body.scopes as string[]);
      return send(response, 200, { clientId: parts[3], scopes: body.scopes });
    }
    throw new ControlError(404, 'Not found.');
  }

  return (request: IncomingMessage, response: ServerResponse): void => {
    route(request, response).catch((error: unknown) => {
      if (error instanceof ControlError || error instanceof DomainError)
        return send(response, error.status, { error: error.message });
      if (error instanceof AccountError || error instanceof FaultError)
        return send(response, 400, { error: error.message });
      console.error(error);
      send(response, 500, { error: 'Internal error.' });
    });
  };
}
