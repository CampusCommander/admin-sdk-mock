import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { createControlHandler } from '../control/control.ts';
import { resolveSpec } from '../seed/spec.ts';
import { clientEnvironment, type ServerInfo } from '../server.ts';
import { startHarness } from '../testing/harness.ts';
import { formatEnvironment } from './env.ts';
import { HELP } from './help.ts';
import { runCli } from './main.ts';

const STARTER = {
  $schema:
    './node_modules/@campuscommander/admin-sdk-mock/schema/config.schema.json',
  dataDir: './.admin-sdk-mock/data',
  listen: { proxy: { port: 3128 } },
  domains: [
    {
      spec: { tier: 'small', seed: 'demo' },
      serviceAccounts: [
        {
          out: './.admin-sdk-mock/credentials/demo.json',
          scopes: 'read-write',
        },
      ],
    },
  ],
};

/** The parent environment without MOCK_* variables, so a developer's shell cannot steer a child. */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('MOCK_')),
  );

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run the CLI in this process with captured output. */
async function cli(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    program?: 'admin-sdk-mock' | 'mockctl';
  } = {},
) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    program: options.program,
  });
  return { code, stdout, stderr };
}

const FAKE_INFO: ServerInfo = {
  version: '1.0.0',
  ready: true,
  listeners: {
    google: { host: '127.0.0.1', port: 8443 },
    control: { host: '127.0.0.1', port: 8080 },
    proxy: null,
  },
  caFile: '/data/ca/ca.pem',
  caBundleFile: '/data/ca/ca-bundle.pem',
  dataDir: '/data',
  domains: [],
};

async function listen(t: TestContext, server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

/** Serve FAKE_INFO at /info and 404 elsewhere, and return the base URL. */
async function fakeMock(t: TestContext): Promise<string> {
  const server = http.createServer((request, response) => {
    if (request.url !== '/info') {
      response.statusCode = 404;
      return response.end();
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(FAKE_INFO));
  });
  return `http://127.0.0.1:${await listen(t, server)}`;
}

/** Spawn `admin-sdk-mock start` with the arguments and collect its standard error. */
function spawnStart(t: TestContext, args: string[]) {
  const child = spawn(
    process.execPath,
    ['bin/admin-sdk-mock.ts', 'start', ...args],
    { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill('SIGKILL'));
  const output = { stderr: '' };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (output.stderr += chunk));
  return { child, output };
}

test('help prints the usage of the CLI and of each command', async () => {
  for (const args of [['--help'], ['-h'], ['help']])
    assert.deepEqual(await cli(args), {
      code: 0,
      stdout: `${HELP['']}\n`,
      stderr: '',
    });
  for (const name of Object.keys(HELP).filter(Boolean)) {
    assert.deepEqual(await cli([name, '--help']), {
      code: 0,
      stdout: `${HELP[name]}\n`,
      stderr: '',
    });
    assert.equal((await cli(['help', name])).stdout, `${HELP[name]}\n`);
  }
  assert.equal(
    (await cli(['domain', 'create', '--help'])).stdout,
    `${HELP.domain}\n`,
  );
  assert.equal(
    (await cli(['config', 'validate', '--help'])).stdout,
    `${HELP.config}\n`,
  );
  assert.match(HELP.domain, /small\|medium\|large\|xlarge\|empty/);
  assert.match(HELP[''], /^Usage: admin-sdk-mock <command>/);

  const unknown = await cli(['nonsense']);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, `Unknown command: nonsense.\n\n${HELP['']}\n`);
  const none = await cli([]);
  assert.equal(none.code, 2);
  assert.equal(none.stderr, `${HELP['']}\n`);
  assert.match(
    (await cli(['nonsense'], { program: 'mockctl' })).stderr,
    /^Usage: mockctl <command>/m,
  );
  const flag = await cli(['init', '--bogus']);
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /--bogus/);
  assert.match(flag.stderr, /Run admin-sdk-mock init --help for its usage\./);
});

test('init writes the starter configuration once and prints the next steps', async (t) => {
  const dir = tempDir(t);
  const read = (name: string) =>
    JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown;
  const first = await cli(['init'], { cwd: dir });
  assert.equal(first.code, 0);
  assert.equal(first.stderr, '');
  assert.deepEqual(read('admin-sdk-mock.json'), STARTER);
  const primary = resolveSpec({ tier: 'small', seed: 'demo' }).primaryDomain;
  for (const step of [
    'npx admin-sdk-mock start',
    'eval "$(npx admin-sdk-mock env)"',
    '.admin-sdk-mock/credentials/demo.json',
    `admin@${primary}`,
    'Add .admin-sdk-mock/ to .gitignore.',
  ])
    assert.ok(first.stdout.includes(step), step);

  assert.deepEqual(await cli(['init'], { cwd: dir }), {
    code: 2,
    stdout: '',
    stderr: 'admin-sdk-mock.json already exists. Pass --force to replace it.\n',
  });
  const custom = await cli(['init', '--force', '--out', 'custom.json'], {
    cwd: dir,
  });
  assert.equal(custom.code, 0);
  assert.deepEqual(read('custom.json'), STARTER);
  assert.ok(
    custom.stdout.includes('npx admin-sdk-mock start --config custom.json'),
  );
  writeFileSync(join(dir, 'admin-sdk-mock.json'), '{}');
  assert.equal((await cli(['init', '--force'], { cwd: dir })).code, 0);
  assert.deepEqual(read('admin-sdk-mock.json'), STARTER);
});

test('config validate prints every error of a configuration file', async (t) => {
  const dir = tempDir(t);
  await cli(['init'], { cwd: dir });
  assert.deepEqual(
    await cli(['config', 'validate', 'admin-sdk-mock.json'], { cwd: dir }),
    { code: 0, stdout: 'admin-sdk-mock.json is valid.\n', stderr: '' },
  );
  writeFileSync(
    join(dir, 'bad.json'),
    JSON.stringify({
      dataDir: 5,
      domains: [{ spec: { tier: 'huge', seed: 'x' } }],
    }),
  );
  assert.deepEqual(
    await cli(['config', 'validate', 'bad.json'], {
      cwd: dir,
      env: { MOCK_GOOGLE_PORT: 'not a port' },
    }),
    {
      code: 2,
      stdout: '',
      stderr:
        'dataDir must be a string.\ndomains[0].spec.tier must be one of: small, medium, large, xlarge, empty.\n',
    },
  );
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify({ users: 5 }));
  writeFileSync(
    join(dir, 'fixtures-config.json'),
    JSON.stringify({
      domains: [
        {
          spec: { tier: 'empty', seed: 'fixtures' },
          fixtures: './fixtures.json',
        },
      ],
    }),
  );
  const fixtures = await cli(['config', 'validate', 'fixtures-config.json'], {
    cwd: dir,
  });
  assert.equal(fixtures.code, 2);
  assert.match(fixtures.stderr, /fixtures\.json/);
  assert.equal(
    (await cli(['config', 'validate', 'missing.json'], { cwd: dir })).stderr,
    `${join(dir, 'missing.json')} does not exist.\n`,
  );
  const usage = await cli(['config', 'validate'], { cwd: dir });
  assert.equal(usage.code, 2);
  assert.ok(usage.stderr.includes(HELP.config));
  assert.equal((await cli(['config', 'check'], { cwd: dir })).code, 2);
});

test('start serves a configuration until SIGTERM, and env and token reach it', async (t) => {
  const dir = tempDir(t);
  const config = join(dir, 'mock.json');
  writeFileSync(
    config,
    JSON.stringify({
      dataDir: './data',
      listen: { google: { port: 0 }, control: { port: 0 }, proxy: { port: 0 } },
      timing: { delays: false },
      domains: [
        {
          spec: { tier: 'empty', seed: 'cli' },
          serviceAccounts: [{ out: './keys/cli.json', scopes: 'read' }],
        },
      ],
    }),
  );
  const { child, output } = spawnStart(t, ['--config', config]);
  const events: Record<string, unknown>[] = [];
  for await (const line of createInterface({ input: child.stdout })) {
    events.push(JSON.parse(line) as Record<string, unknown>);
    if (events.at(-1)!.event === 'ready') break;
  }
  assert.deepEqual(
    events.map((event) => event.event),
    ['started', 'domain', 'ready'],
  );
  const { event: _event, ...rest } = events[2];
  const info = rest as unknown as ServerInfo;
  const control = `http://127.0.0.1:${info.listeners.control.port}`;
  const expected = clientEnvironment(info, control);
  assert.equal(
    expected.HTTPS_PROXY,
    `http://127.0.0.1:${info.listeners.proxy!.port}`,
  );

  const json = await cli(['env', '--control', control, '--format', 'json'], {
    cwd: dir,
  });
  assert.equal(json.code, 0);
  assert.equal(json.stderr, '');
  assert.deepEqual(JSON.parse(json.stdout), expected);
  assert.equal(
    (await cli(['env'], { cwd: dir, env: { MOCK_CONTROL_URL: control } }))
      .stdout,
    formatEnvironment(expected, 'sh'),
  );

  const githubEnv = join(dir, 'github-env');
  writeFileSync(githubEnv, 'EXISTING=1\n');
  const github = await cli(['env', '--format', 'github'], {
    cwd: dir,
    env: { MOCK_CONTROL_URL: control, GITHUB_ENV: githubEnv },
  });
  assert.equal(github.code, 0);
  assert.equal(github.stdout, '');
  assert.equal(
    readFileSync(githubEnv, 'utf8'),
    `EXISTING=1\n${formatEnvironment(expected, 'github')}`,
  );

  const customerId = info.domains[0].customerId;
  const token = await cli([
    'token',
    customerId,
    '--scopes',
    'read',
    '--control',
    control,
  ]);
  assert.equal(token.code, 0);
  const body = JSON.parse(token.stdout) as Record<string, unknown>;
  assert.match(body.access_token as string, /^ya29\./);
  assert.equal(body.scope, READ_SCOPES.join(' '));
  const raw = await cli(['token', customerId, '--raw', '--ttl', '60'], {
    env: { MOCK_CONTROL_URL: control },
  });
  assert.match(raw.stdout, /^ya29\.\S+\n$/);

  child.kill('SIGTERM');
  const [code] = (await once(child, 'exit')) as [number];
  assert.equal(code, 0, output.stderr);
});

test('start exits 2 with each configuration error on standard error', async (t) => {
  const dir = tempDir(t);
  const config = join(dir, 'bad.json');
  writeFileSync(
    config,
    JSON.stringify({
      dataDir: 5,
      domains: [{ spec: { tier: 'huge', seed: 'x' } }],
    }),
  );
  const { child, output } = spawnStart(t, ['--config', config]);
  const [code] = (await once(child, 'exit')) as [number];
  assert.equal(code, 2);
  assert.equal(
    output.stderr,
    'dataDir must be a string.\ndomains[0].spec.tier must be one of: small, medium, large, xlarge, empty.\n',
  );

  const flags = await cli(
    ['start', '--google-port', 'eighty', '--scale', '0'],
    { cwd: dir },
  );
  assert.equal(flags.code, 2);
  assert.equal(
    flags.stderr,
    '--google-port must be a whole number from 0 to 65535.\n--scale: The time scale must be from 1 to 100000.\n',
  );
  assert.deepEqual(await cli(['start', '--delays', 'maybe'], { cwd: dir }), {
    code: 2,
    stdout: '',
    stderr: '--delays must be on or off.\n',
  });
});

test('start exits 1 when a listener port is taken', async (t) => {
  const dir = tempDir(t);
  const port = await listen(t, net.createServer());
  const result = await cli(
    ['start', '--google-port', '0', '--control-port', String(port)],
    { cwd: dir },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /EADDRINUSE/);
});

test('doctor checks Node, the configuration, the data directory, and the ports', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'admin-sdk-mock.json');
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  const ports = { google: { port: 0 }, control: { port: 0 } };
  write({ listen: { ...ports, proxy: { port: 0 } } });
  const passing = await cli(['doctor'], { cwd: dir });
  assert.equal(passing.code, 0, passing.stdout);
  assert.deepEqual(passing.stdout.trimEnd().split('\n'), [
    `PASS Node.js ${process.versions.node} satisfies >=24.11.`,
    `PASS Configuration ${file} is valid.`,
    `PASS Data directory ${join(dir, 'data')} is writable.`,
    `PASS CA file ${join(dir, 'data', 'ca', 'ca.pem')} is writable.`,
    'PASS Google listener 127.0.0.1:0 picks a free port.',
    'PASS Control listener 127.0.0.1:0 picks a free port.',
    'PASS Proxy listener 127.0.0.1:0 picks a free port.',
  ]);

  const held = await listen(t, net.createServer());
  write({ listen: { google: { port: 0 }, control: { port: held } } });
  const failing = await cli(['doctor'], { cwd: dir });
  assert.equal(failing.code, 1);
  assert.ok(
    failing.stdout.includes(
      `FAIL Control listener 127.0.0.1:${held} is in use.`,
    ),
    failing.stdout,
  );
  assert.ok(failing.stdout.includes('PASS Google listener 127.0.0.1:0'));
  assert.ok(!failing.stdout.includes('Proxy listener'));

  write({ dataDir: 5 });
  const invalid = await cli(['doctor'], { cwd: dir });
  assert.equal(invalid.code, 1);
  assert.ok(
    invalid.stdout.includes(
      `FAIL Configuration ${file}: dataDir must be a string.`,
    ),
    invalid.stdout,
  );

  rmSync(file);
  const env = { MOCK_GOOGLE_PORT: '0', MOCK_CONTROL_PORT: '0' };
  const bare = await cli(['doctor'], { cwd: dir, env });
  assert.equal(bare.code, 0, bare.stdout);
  assert.ok(!bare.stdout.includes('Configuration'));

  if (process.getuid?.() !== 0) {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const denied = await cli(['doctor'], {
        cwd: dir,
        env: { ...env, MOCK_DATA_DIR: join(locked, 'data') },
      });
      assert.equal(denied.code, 1);
      assert.ok(
        denied.stdout.includes(
          `FAIL Data directory ${join(locked, 'data')} is not writable.`,
        ),
        denied.stdout,
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  }
});

test('env reports a missing mock, a missing GITHUB_ENV, and a proxy that is off', async (t) => {
  const dropping = net.createServer((socket) => socket.destroy());
  const dead = `http://127.0.0.1:${await listen(t, dropping)}`;
  assert.deepEqual(await cli(['env', '--control', dead]), {
    code: 1,
    stdout: '',
    stderr: `No mock answers at ${dead}.\n`,
  });
  assert.deepEqual(
    await cli(['env', '--format', 'github', '--control', dead]),
    {
      code: 2,
      stdout: '',
      stderr: 'GITHUB_ENV is not set.\n',
    },
  );
  assert.equal((await cli(['env', '--format', 'yaml'])).code, 2);

  const url = await fakeMock(t);
  const off = await cli(['env', '--format', 'dotenv'], {
    env: { MOCK_CONTROL_URL: `${url}/` },
  });
  assert.equal(off.code, 0);
  assert.equal(
    off.stderr,
    'The proxy is off. Set listen.proxy in the configuration to route clients through it.\n',
  );
  assert.equal(
    off.stdout,
    formatEnvironment(clientEnvironment(FAKE_INFO, url), 'dotenv'),
  );
  assert.ok(!off.stdout.includes('HTTPS_PROXY'));
});

test('env reads the control listener from the found configuration', async (t) => {
  const dir = tempDir(t);
  const port = new URL(await fakeMock(t)).port;
  writeFileSync(
    join(dir, 'admin-sdk-mock.json'),
    JSON.stringify({
      listen: { control: { host: '0.0.0.0', port: Number(port) } },
    }),
  );
  const found = await cli(['env', '--format', 'json'], { cwd: dir });
  assert.equal(found.code, 0, found.stderr);
  assert.equal(
    JSON.parse(found.stdout).ADMIN_SDK_MOCK_CONTROL,
    `http://127.0.0.1:${port}`,
  );
});

test('every control command works through runCli with the same output', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const control = `http://127.0.0.1:${await listen(
    t,
    http.createServer(createControlHandler(harness.mock)),
  )}`;
  const dir = harness.dataDir;
  const ctl = (...args: string[]) =>
    cli([...args, '--control', control], { cwd: dir });
  const api = async (path: string) => {
    const response = await fetch(`${control}${path}`);
    return response.headers.get('content-type')?.includes('json')
      ? ((await response.json()) as unknown)
      : await response.text();
  };
  const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const ok = async (...args: string[]) => {
    const result = await ctl(...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    return result.stdout;
  };

  const created = JSON.parse(
    await ok('domain', 'create', '--tier', 'empty', '--seed', 'cli-control'),
  ) as { customerId: string; adminEmail: string };
  const id = created.customerId;
  assert.match(id, /^C0/);
  assert.equal(await ok('domain', 'list'), pretty(await api('/domains')));
  assert.equal(
    await ok('domain', 'show', id),
    pretty(await api(`/domains/${id}`)),
  );
  const sized = JSON.parse(
    await ok(
      'domain',
      'create',
      '--tier',
      'small',
      '--seed',
      'cli-sized',
      '--name',
      'Sized District',
      '--layout',
      'school-first',
      '--counts',
      '{"schools":1,"students":30,"staff":5,"devices":20}',
      '--rates',
      '{"suspended":0}',
    ),
  ) as { customerId: string; districtName: string };
  assert.equal(sized.districtName, 'Sized District');

  const key = JSON.parse(await ok('credential', id)) as { type: string };
  assert.equal(key.type, 'service_account');
  const grants = [
    [undefined, READ_SCOPES],
    ['read', READ_SCOPES],
    ['read-write', READ_WRITE_SCOPES],
    [READ_SCOPES.slice(0, 2).join(', '), READ_SCOPES.slice(0, 2)],
  ] as const;
  for (const [index, [words, scopes]] of grants.entries()) {
    const out = join(dir, `credential-${index}.json`);
    const written = JSON.parse(
      await ok(
        'credential',
        id,
        '--out',
        out,
        ...(words ? ['--scopes', words] : []),
      ),
    ) as { written: string; clientId: string; scopes: string[] };
    assert.equal(written.written, out);
    assert.deepEqual(written.scopes, [...scopes]);
    assert.deepEqual(harness.mock.registry.grant(id, written.clientId), [
      ...scopes,
    ]);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(
      (JSON.parse(readFileSync(out, 'utf8')) as { client_id: string })
        .client_id,
      written.clientId,
    );
  }

  const settings = JSON.parse(
    await ok('settings', id, '--json', '{"quota":{"perMinute":7}}'),
  ) as { quota: { perMinute: number } };
  assert.equal(settings.quota.perMinute, 7);
  assert.equal(
    await ok('quota', id),
    pretty(await api(`/domains/${id}/quota`)),
  );
  const fault = JSON.parse(
    await ok('fault', 'add', id, '--json', '{"kind":"reset","count":1}'),
  ) as { id: unknown };
  assert.ok(fault.id !== undefined);
  assert.equal(
    await ok('fault', 'list', id),
    pretty(await api(`/domains/${id}/faults`)),
  );
  assert.deepEqual(JSON.parse(await ok('fault', 'clear', id)), { cleared: id });
  assert.deepEqual(JSON.parse(await ok('index', 'flush', id)), {
    flushed: 0,
    delaysEnded: 0,
  });
  assert.deepEqual(JSON.parse(await ok('clock')), { scale: 1, delays: false });
  assert.deepEqual(
    JSON.parse(await ok('clock', '--scale', '60', '--delays', 'on')),
    { scale: 60, delays: true },
  );
  const pem = (await api('/ca.pem')) as string;
  assert.equal(await ok('ca'), `${pem.trimEnd()}\n`);
  const caFile = join(dir, 'exported-ca.pem');
  assert.deepEqual(JSON.parse(await ok('ca', '--out', caFile)), {
    written: caFile,
  });
  assert.equal(readFileSync(caFile, 'utf8'), pem);

  const token = JSON.parse(
    await ok('token', id, '--scopes', READ_SCOPES[0], '--ttl', '30'),
  ) as Record<string, unknown>;
  assert.equal(token.scope, READ_SCOPES[0]);
  assert.equal(token.expires_in, 30);
  assert.equal(
    JSON.parse(await ok('token', id, '--subject', created.adminEmail)).scope,
    READ_WRITE_SCOPES.join(' '),
  );

  assert.equal((await ok('domain', 'reset', id)).length > 0, true);
  assert.deepEqual(JSON.parse(await ok('domain', 'delete', id)), {
    deleted: id,
  });

  const missing = await ctl('domain', 'show', 'C0missing');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^404: /);
  for (const [args, message] of [
    [['index', 'flush'], 'A customer ID is required.'],
    [['clock', '--delays', 'yes'], '--delays must be on or off.'],
    [['settings', 'C0x'], '--json is required.'],
    [['settings', 'C0x', '--json', '{'], '--json is not valid JSON.'],
    [
      ['token', 'C0x', '--ttl', 'soon'],
      '--ttl must be a whole number of seconds.',
    ],
  ] as const)
    assert.deepEqual(await ctl(...args), {
      code: 1,
      stdout: '',
      stderr: `${message}\n`,
    });
  assert.deepEqual(
    await ctl('token', sized.customerId, '--subject', 'nobody@nowhere.test'),
    {
      code: 1,
      stdout: '',
      stderr: '400: subject must name a user of the domain.\n',
    },
  );
  for (const args of [['domain'], ['domain', 'explode'], ['fault', 'nudge']]) {
    const usage = await ctl(...args);
    assert.equal(usage.code, 2, args.join(' '));
    assert.ok(usage.stderr.includes(HELP[args[0]]), args.join(' '));
  }
  assert.equal(
    (await cli(['clock'], { env: { MOCK_CONTROL_URL: `${control}/` } })).code,
    0,
  );
});
