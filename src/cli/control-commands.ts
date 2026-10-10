import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { writeSecret } from '../write-file.ts';
import { usageFailure } from './help.ts';
import type { Io } from './main.ts';

const DEFAULT_CONTROL_URL = 'http://127.0.0.1:8080';
const MAX_TOKEN_SECONDS = 3600;

/**
 * A failure of a control command that mockctl had before 1.0. The CLI prints its message
 * and exits with code 1, as mockctl always did, even for a missing or invalid value.
 */
class CliError extends Error {}

/** Invalid usage. The CLI prints its message and exits with code 2. */
export class UsageError extends Error {}

/**
 * The control URL: --control, then MOCK_CONTROL_URL, then ADMIN_SDK_MOCK_CONTROL (which
 * `env` exports), then the fallback. A given value must be an http or https URL.
 */
export function controlUrl(
  flag: string | undefined,
  io: Io,
  fallback: () => string = () => DEFAULT_CONTROL_URL,
): string {
  const given = (
    [
      ['--control', flag],
      ['MOCK_CONTROL_URL', io.env.MOCK_CONTROL_URL],
      ['ADMIN_SDK_MOCK_CONTROL', io.env.ADMIN_SDK_MOCK_CONTROL],
    ] as const
  ).find(([, value]) => value);
  if (!given) return fallback();
  const [source, value] = given as readonly [string, string];
  let protocol: string | undefined;
  try {
    protocol = new URL(value).protocol;
  } catch {
    /* Not a URL. */
  }
  if (protocol !== 'http:' && protocol !== 'https:')
    throw new UsageError(`${source} is not an http or https URL: ${value}.`);
  return value.replace(/\/+$/, '');
}

/** The message for a mock that does not answer, with the cause: an error code or message. */
export function noMockMessage(url: string, error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const source = cause instanceof Error ? cause : error;
  const reason =
    (source as NodeJS.ErrnoException | null)?.code ??
    (source instanceof Error ? source.message : String(source));
  return `No mock answers at ${url} (${reason}).`;
}

/** Expand `read` and `read-write`, or split a comma-separated scope list. */
const scopeList = (text: string): string[] => {
  if (text === 'read') return [...READ_SCOPES];
  if (text === 'read-write') return [...READ_WRITE_SCOPES];
  return text.split(',').map((scope) => scope.trim());
};

const json = (text: string | undefined, label: string): unknown => {
  if (text === undefined) throw new CliError(`${label} is required.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${label} is not valid JSON.`);
  }
};

/** Run one control command against the control API. `argv` starts with the command name. */
export async function runControlCommand(
  argv: string[],
  io: Io,
): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      control: { type: 'string' },
      tier: { type: 'string' },
      seed: { type: 'string' },
      name: { type: 'string' },
      layout: { type: 'string' },
      counts: { type: 'string' },
      rates: { type: 'string' },
      scopes: { type: 'string' },
      project: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'string' },
      scale: { type: 'string' },
      delays: { type: 'string' },
      subject: { type: 'string' },
      ttl: { type: 'string' },
      raw: { type: 'boolean' },
    },
  });
  const base = controlUrl(values.control, io);

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers:
          body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new CliError(noMockMessage(base, error));
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error: string }).error;
      } catch {
        /* The body is not JSON. */
      }
      throw new CliError(`${response.status}: ${message}`);
    }
    if (text === '') return undefined;
    return response.headers.get('content-type')?.includes('json')
      ? JSON.parse(text)
      : text;
  }

  const print = (value: unknown): number => {
    if (value !== undefined)
      io.stdout(
        `${
          typeof value === 'string'
            ? value.trimEnd()
            : JSON.stringify(value, null, 2)
        }\n`,
      );
    return 0;
  };

  const [command, sub, third] = positionals;
  const id = (value: string | undefined) => {
    if (!value) throw new CliError('A customer ID is required.');
    return encodeURIComponent(value);
  };
  switch (command) {
    case 'domain':
      switch (sub) {
        case 'create':
          return print(
            await call('POST', '/domains', {
              tier: values.tier,
              seed: values.seed,
              ...(values.name ? { name: values.name } : {}),
              ...(values.layout ? { layout: values.layout } : {}),
              ...(values.counts
                ? { counts: json(values.counts, '--counts') }
                : {}),
              ...(values.rates ? { rates: json(values.rates, '--rates') } : {}),
            }),
          );
        case 'list':
          return print(await call('GET', '/domains'));
        case 'show':
          return print(await call('GET', `/domains/${id(third)}`));
        case 'reset':
          return print(await call('POST', `/domains/${id(third)}/reset`));
        case 'delete':
          await call('DELETE', `/domains/${id(third)}`);
          return print({ deleted: third });
      }
      break;
    case 'credential': {
      const account = (await call(
        'POST',
        `/domains/${id(sub)}/service-accounts`,
        {
          ...(values.project ? { projectId: values.project } : {}),
        },
      )) as { client_id: string };
      const scopes = values.scopes ? scopeList(values.scopes) : READ_SCOPES;
      await call('PUT', `/domains/${id(sub)}/delegation/${account.client_id}`, {
        scopes,
      });
      if (values.out) {
        writeSecret(
          resolve(io.cwd, values.out),
          `${JSON.stringify(account, null, 2)}\n`,
        );
        return print({
          written: values.out,
          clientId: account.client_id,
          scopes,
        });
      }
      return print(account);
    }
    case 'token': {
      if (!sub) throw new UsageError('A customer ID is required.');
      const path = `/domains/${id(sub)}/tokens`;
      const body: Record<string, unknown> = {};
      if (values.subject !== undefined) body.subject = values.subject;
      if (values.scopes !== undefined)
        body.scopes =
          values.scopes === 'read' || values.scopes === 'read-write'
            ? values.scopes
            : scopeList(values.scopes);
      if (values.ttl !== undefined) {
        const ttl = /^\d+$/.test(values.ttl) ? Number(values.ttl) : NaN;
        if (!(ttl >= 1 && ttl <= MAX_TOKEN_SECONDS))
          throw new UsageError(
            `--ttl must be a whole number of seconds from 1 to ${MAX_TOKEN_SECONDS}.`,
          );
        body.ttlSeconds = ttl;
      }
      const token = (await call('POST', path, body)) as {
        access_token: string;
      };
      return print(values.raw ? token.access_token : token);
    }
    case 'settings':
      return print(
        await call(
          'PUT',
          `/domains/${id(sub)}/settings`,
          json(values.json, '--json'),
        ),
      );
    case 'quota':
      return print(await call('GET', `/domains/${id(sub)}/quota`));
    case 'fault':
      switch (sub) {
        case 'add':
          return print(
            await call(
              'POST',
              `/domains/${id(third)}/faults`,
              json(values.json, '--json'),
            ),
          );
        case 'list':
          return print(await call('GET', `/domains/${id(third)}/faults`));
        case 'clear':
          await call('DELETE', `/domains/${id(third)}/faults`);
          return print({ cleared: third });
      }
      break;
    case 'index':
      if (sub === 'flush')
        return print(await call('POST', `/domains/${id(third)}/index/flush`));
      break;
    case 'clock': {
      const body: Record<string, unknown> = {};
      if (values.scale !== undefined) body.scale = Number(values.scale);
      if (values.delays !== undefined) {
        if (values.delays !== 'on' && values.delays !== 'off')
          throw new CliError('--delays must be on or off.');
        body.delays = values.delays === 'on';
      }
      return print(
        await call(
          Object.keys(body).length > 0 ? 'PUT' : 'GET',
          '/clock',
          Object.keys(body).length > 0 ? body : undefined,
        ),
      );
    }
    case 'ca': {
      const pem = (await call('GET', '/ca.pem')) as string;
      if (values.out) {
        writeFileSync(resolve(io.cwd, values.out), pem, { mode: 0o644 });
        return print({ written: values.out });
      }
      return print(pem);
    }
  }
  return usageFailure(
    io,
    command,
    sub === undefined ? undefined : `Unknown ${command} command: ${sub}.`,
  );
}
