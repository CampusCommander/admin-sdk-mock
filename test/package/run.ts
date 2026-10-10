/**
 * Proves that the packed tarball installs into an empty project and works there:
 * as a CLI, as an API, and with TypeScript types.
 *
 * Installing from the private GitHub repository needs repository access, so the test
 * packs the same files that the repository install would produce. A last step installs
 * `git+file://<repo>#<HEAD>`, which clones the commit and builds dist/ through the
 * prepare script, as a GitHub install does.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../../src/testing/child-env.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageName = '@campuscommander/admin-sdk-mock';
const READY_TIMEOUT_MS = 120_000;

const repoPackage = JSON.parse(
  readFileSync(join(repo, 'package.json'), 'utf8'),
) as { devDependencies: Record<string, string> };
const dev = (name: string): string => {
  const version = repoPackage.devDependencies[name];
  if (!version) throw new Error(`package.json has no devDependency ${name}.`);
  return `${name}@${version}`;
};

class StepFailure extends Error {}

function step(message: string): void {
  console.log(`ok - ${message}`);
}

/** Never let npx fetch a package or wait on a prompt. */
/**
 * The environment for every child. `npm run test:package` exports the parent npm's
 * settings as npm_* variables, and a nested npm treats them as command-line flags
 * (npm 11 refuses `allow-scripts` from them in a project install). The children read
 * the same configuration files themselves, so drop the copies.
 */
const baseEnv: NodeJS.ProcessEnv = {
  // childEnv also drops MOCK_* and ADMIN_SDK_MOCK_*, so the developer's shell cannot steer the mock.
  ...Object.fromEntries(
    Object.entries(childEnv()).filter(([name]) => !/^npm_/i.test(name)),
  ),
  npm_config_yes: 'false',
};

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
  env: NodeJS.ProcessEnv = baseEnv,
): string {
  const finalArgs = command === 'npx' ? ['--no-install', ...args] : args;
  const started = Date.now();
  const result = spawnSync(command, finalArgs, {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const label = `${command} ${finalArgs.join(' ')}`;
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  )
    throw new StepFailure(
      `${label} timed out after ${elapsed} s (limit ${timeoutMs / 1000} s)\n${result.stdout}\n${result.stderr}`,
    );
  if (result.status !== 0)
    throw new StepFailure(
      `${label} exited ${result.status} after ${elapsed} s\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

const cliClient = `
import { readFileSync } from 'node:fs';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';

const key = JSON.parse(readFileSync(process.env.KEY_FILE, 'utf8'));
const auth = new JWT({
  email: key.client_email,
  key: key.private_key,
  subject: process.env.SUBJECT,
  scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
});
const directory = admin({ version: 'directory_v1', auth });
const { data } = await directory.users.list({ customer: 'my_customer', maxResults: 5 });
if (!data.users || data.users.length === 0) throw new Error('No users were listed.');
console.log('users', data.users.length);
`;

const apiClient = `
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { startMock } from '@campuscommander/admin-sdk-mock';

const handle = await startMock({
  config: { domains: [{ spec: { tier: 'small', seed: 'package', counts: { schools: 1, students: 20, staff: 5, devices: 10 } } }] },
});
try {
  const restore = handle.useInProcess();
  const [domain] = handle.domains;
  const key = handle.credential(domain.customerId, 'read');
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    subject: domain.adminEmail,
    scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
  });
  const directory = admin({ version: 'directory_v1', auth });
  const { data } = await directory.users.list({ customer: 'my_customer', maxResults: 5 });
  if (!data.users || data.users.length === 0) throw new Error('No users were listed.');
  console.log('users', data.users.length);
  restore();
} finally {
  await handle.close();
}
`;

const consumerTs = `import { startMock, type MockHandle, type MockOptions } from '@campuscommander/admin-sdk-mock';

const options: MockOptions = { proxy: { passthrough: true } };
const handle: MockHandle = await startMock(options);
const restore: () => void = handle.useInProcess();
restore();
await handle.close();
`;

/** Start the mock and resolve with its ready event. */
function waitForReady(child: ChildProcess, stderr: () => string) {
  return new Promise<{
    domains: { adminEmail: string; serviceAccounts: { out: string }[] }[];
    listeners: { control: { host: string; port: number } };
  }>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () =>
        reject(
          new StepFailure(
            `The mock sent no ready line within ${READY_TIMEOUT_MS / 1000} s.\n${stderr()}`,
          ),
        ),
      READY_TIMEOUT_MS,
    );
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const event = JSON.parse(line) as { event?: string };
          if (event.event === 'ready') {
            clearTimeout(timer);
            resolve(event as never);
          }
        } catch {
          // Ignore lines that are not JSON.
        }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new StepFailure(`The mock exited ${code} before ready.\n${stderr()}`),
      );
    });
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'admin-sdk-mock-package-'));
let mock: ChildProcess | undefined;
let failed = false;
/** Signal the whole process group, because npx runs the mock as a child. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group already exited.
  }
}

function groupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

let stopping: Promise<void> | undefined;
/** The exit code a received signal asks for, set once. */
let signalExit: number | undefined;

/**
 * Stop the mock and wait until its whole process group is gone. The first call
 * signals the group and escalates to SIGKILL after 10 s. Later calls share its promise.
 */
function stopMock(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  return (stopping ??= (async () => {
    const child = mock;
    if (!child) return;
    signalGroup(child, signal);
    const deadline = Date.now() + 10_000;
    let killed = false;
    while (groupAlive(child)) {
      if (!killed && Date.now() >= deadline) {
        signalGroup(child, 'SIGKILL');
        killed = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })());
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)
  process.once(signal, () => {
    signalExit ??= code;
    void stopMock().finally(() => {
      rmSync(tmp, { recursive: true, force: true });
      process.exit(signalExit);
    });
  });

try {
  // 1. Pack the repository. The prepare script builds dist/.
  const packOutput = run(
    'npm',
    ['pack', '--pack-destination', tmp, '--json', '--foreground-scripts=false'],
    repo,
    300_000,
  );
  // Take the last JSON array in stdout, in case a build script wrote before it.
  const packed = JSON.parse(
    packOutput.slice(
      packOutput.lastIndexOf('\n[') + 1 || packOutput.indexOf('['),
    ),
  ) as { filename: string }[];
  if (!packed[0])
    throw new StepFailure(`npm pack listed no file:\n${packOutput}`);
  const tarball = join(tmp, packed[0].filename);
  if (!existsSync(tarball)) throw new StepFailure(`No tarball at ${tarball}.`);
  step(`packed ${packed[0]!.filename}`);

  // 2. Install into an empty project.
  const consumer = join(tmp, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      tarball,
      dev('@googleapis/admin'),
      dev('google-auth-library'),
      dev('@types/node'),
      dev('typescript'),
      '--no-audit',
      '--no-fund',
    ],
    consumer,
    300_000,
  );
  step('installed the tarball and its peers into an empty project');

  // 3. Check the installed files.
  const installed = join(consumer, 'node_modules', packageName);
  for (const file of [
    'dist/src/index.js',
    'dist/src/index.d.ts',
    'dist/bin/admin-sdk-mock.js',
    'schema/config.schema.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE.md',
  ])
    if (!existsSync(join(installed, file)))
      throw new StepFailure(`The package lacks ${file}.`);
  for (const directory of ['src', 'test', 'dist/src/docs', 'dist/src/testing'])
    if (existsSync(join(installed, directory)))
      throw new StepFailure(`The package holds a ${directory}/ directory.`);
  const tests = walk(installed).filter((file) => file.endsWith('.test.js'));
  if (tests.length > 0)
    throw new StepFailure(`The package holds test files:\n${tests.join('\n')}`);
  step(
    'the installed package holds the expected files, and no tests or development modules',
  );

  // 4. The help output of both executables.
  for (const name of ['admin-sdk-mock', 'mockctl']) {
    const help = run('npx', [name, '--help'], consumer);
    if (!help.includes(`Usage: ${name} <command> [options]`))
      throw new StepFailure(`${name} --help lacks its usage line:\n${help}`);
  }
  step('admin-sdk-mock --help and mockctl --help exit 0 and print usage');

  // 5. Validate a configuration.
  const keyFile = join(consumer, 'keys', 'read.json');
  writeFileSync(
    join(consumer, 'admin-sdk-mock.json'),
    JSON.stringify({
      dataDir: './data',
      listen: {
        google: { host: '127.0.0.1', port: 0 },
        control: { host: '127.0.0.1', port: 0 },
        proxy: { host: '127.0.0.1', port: 0 },
      },
      domains: [
        {
          spec: {
            tier: 'small',
            seed: 'package',
            counts: { schools: 1, students: 20, staff: 5, devices: 10 },
          },
          serviceAccounts: [{ out: keyFile, scopes: 'read' }],
        },
      ],
    }),
  );
  run(
    'npx',
    ['admin-sdk-mock', 'config', 'validate', 'admin-sdk-mock.json'],
    consumer,
  );
  step('config validate exits 0');

  // 6. Run the mock as a process and list users through its environment.
  let stderr = '';
  mock = spawn(
    'npx',
    [
      '--no-install',
      'admin-sdk-mock',
      'start',
      '--config',
      'admin-sdk-mock.json',
    ],
    {
      cwd: consumer,
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  mock.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const ready = await waitForReady(mock, () => stderr);
  const controlUrl = `http://${ready.listeners.control.host}:${ready.listeners.control.port}`;
  const environment = JSON.parse(
    run(
      'npx',
      ['admin-sdk-mock', 'env', '--control', controlUrl, '--format', 'json'],
      consumer,
    ),
  ) as Record<string, string>;
  writeFileSync(join(consumer, 'cli-client.mjs'), cliClient);
  const domain = ready.domains[0]!;
  const output = run('node', ['cli-client.mjs'], consumer, 60_000, {
    ...baseEnv,
    ...environment,
    KEY_FILE: domain.serviceAccounts[0]!.out,
    SUBJECT: domain.adminEmail,
  });
  step(`the CLI client listed users through the mock (${output.trim()})`);
  await stopMock();

  // 7. Run the API in process.
  writeFileSync(join(consumer, 'api-client.mjs'), apiClient);
  const apiOutput = run('node', ['api-client.mjs'], consumer);
  step(`the API client listed users in process (${apiOutput.trim()})`);

  // 8. Type check a consumer.
  writeFileSync(join(consumer, 'consumer.ts'), consumerTs);
  run(
    'npx',
    [
      'tsc',
      '--noEmit',
      '--strict',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--target',
      'es2024',
      '--types',
      'node',
      'consumer.ts',
    ],
    consumer,
    120_000,
  );
  step('consumer.ts type checks under strict nodenext');

  // 9. Install the HEAD commit from a clean Git clone into a second empty project.
  // npm clones the commit, installs its dev dependencies, and runs prepare to build dist/.
  const sha = run('git', ['rev-parse', 'HEAD'], repo).trim();
  const gitConsumer = join(tmp, 'git-consumer');
  mkdirSync(gitConsumer);
  writeFileSync(
    join(gitConsumer, 'package.json'),
    JSON.stringify({ name: 'git-consumer', private: true, type: 'module' }),
  );
  // An empty user configuration, so a developer's allow-scripts or ignore-scripts
  // setting cannot break or skip prepare. The installation guide documents both.
  const userconfig = join(tmp, 'empty.npmrc');
  writeFileSync(userconfig, '');
  const spec = `git+file://${repo}#${sha}`;
  run(
    'npm',
    ['install', spec, '--userconfig', userconfig, '--no-audit', '--no-fund'],
    gitConsumer,
    300_000,
  );
  const built = join(
    gitConsumer,
    'node_modules',
    packageName,
    'dist',
    'bin',
    'admin-sdk-mock.js',
  );
  if (!existsSync(built))
    throw new StepFailure(
      `The Git install lacks ${built}. prepare did not run.`,
    );
  const gitHelp = run('npx', ['admin-sdk-mock', '--help'], gitConsumer);
  if (!gitHelp.includes('Usage: admin-sdk-mock <command> [options]'))
    throw new StepFailure(
      `admin-sdk-mock --help after the Git install lacks its usage line:\n${gitHelp}`,
    );
  step(
    `installed git+file://<repo>#${sha.slice(0, 7)}: prepare built dist/, and admin-sdk-mock --help prints usage`,
  );
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await stopMock();
  // 10. Remove the temporary directory.
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(signalExit ?? (failed ? 1 : 0));
