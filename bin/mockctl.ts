#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { READ_SCOPES } from '../src/auth/scopes.ts';

const BASE = (process.env.MOCK_CONTROL_URL ?? 'http://127.0.0.1:8080').replace(
  /\/$/,
  '',
);

const USAGE = `Usage: mockctl <command>

  domain create --tier <small|medium|large|xlarge> --seed <seed> [--name <name>] [--layout <role-first|school-first>] [--counts <json>] [--rates <json>]
  domain list
  domain show <customerId>
  domain reset <customerId>
  domain delete <customerId>
  credential <customerId> [--scopes <a,b>] [--project <id>] [--out <file>]
  settings <customerId> --json <patch>
  quota <customerId>
  fault add <customerId> --json <rule>
  fault list <customerId>
  fault clear <customerId>
  clock [--scale <n>] [--delays <on|off>]
  ca [--out <file>]

MOCK_CONTROL_URL selects the control API. The default is ${BASE}.`;

class CliError extends Error {}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

const json = (text: string | undefined, label: string): unknown => {
  if (text === undefined) throw new CliError(`${label} is required.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${label} is not valid JSON.`);
  }
};

const print = (value: unknown) => {
  if (value !== undefined)
    console.log(
      typeof value === 'string'
        ? value.trimEnd()
        : JSON.stringify(value, null, 2),
    );
};

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
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
    },
  });
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
      const scopes = values.scopes
        ? values.scopes.split(',').map((scope) => scope.trim())
        : READ_SCOPES;
      await call('PUT', `/domains/${id(sub)}/delegation/${account.client_id}`, {
        scopes,
      });
      if (values.out) {
        writeFileSync(values.out, `${JSON.stringify(account, null, 2)}\n`, {
          mode: 0o600,
        });
        return print({
          written: values.out,
          clientId: account.client_id,
          scopes,
        });
      }
      return print(account);
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
    case 'clock': {
      const body: Record<string, unknown> = {};
      if (values.scale !== undefined) body.scale = Number(values.scale);
      if (values.delays !== undefined) body.delays = values.delays === 'on';
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
        writeFileSync(values.out, pem, { mode: 0o644 });
        return print({ written: values.out });
      }
      return print(pem);
    }
  }
  throw new CliError(USAGE);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
