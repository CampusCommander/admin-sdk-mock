import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccountError, issueServiceAccount } from '../auth/accounts.ts';
import { MAX_SCALE } from '../clock.ts';
import { DomainError } from '../domains.ts';
import { FaultError } from '../faults/faults.ts';
import type { Mock } from '../mock.ts';

const BODY_LIMIT = 1024 * 1024;

class ControlError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ControlError';
    this.status = status;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
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
export function createControlHandler(mock: Mock) {
  const domainOrThrow = (id: string) => {
    const domain = mock.domains.get(id);
    if (!domain) throw new ControlError(404, `Domain ${id} does not exist.`);
    return domain;
  };

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://control.invalid').pathname;
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);

    if (method === 'GET' && path === '/health')
      return send(response, 200, {
        status: 'ok',
        domains: mock.domains.list().length,
      });
    if (method === 'GET' && path === '/ca.pem')
      return send(
        response,
        200,
        mock.certificates.caCert,
        'application/x-pem-file',
      );
    if (path === '/clock') {
      if (method === 'PUT') {
        const body = (await readJson(request)) as {
          scale?: unknown;
          delays?: unknown;
        };
        if (body.scale !== undefined) {
          if (
            typeof body.scale !== 'number' ||
            body.scale < 1 ||
            body.scale > MAX_SCALE
          )
            throw new ControlError(
              400,
              `scale must be a number from 1 to ${MAX_SCALE}.`,
            );
          if (body.scale !== mock.timing.scale) mock.limits.reset();
          mock.timing.scale = body.scale;
        }
        if (body.delays !== undefined) {
          if (typeof body.delays !== 'boolean')
            throw new ControlError(400, 'delays must be true or false.');
          mock.timing.delays = body.delays;
        }
      } else if (method !== 'GET') throw new ControlError(404, 'Not found.');
      return send(response, 200, mock.timing);
    }
    if (parts[0] !== 'domains') throw new ControlError(404, 'Not found.');

    if (parts.length === 1) {
      if (method === 'GET') return send(response, 200, mock.domains.list());
      if (method === 'POST') {
        const { domain, result } = mock.domains.create(
          await readJson(request),
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
          const body = (await readJson(request)) as { projectId?: unknown };
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
    if (parts.length === 4 && parts[2] === 'delegation' && method === 'PUT') {
      domainOrThrow(id);
      const body = (await readJson(request)) as { scopes?: unknown };
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
