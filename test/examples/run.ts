import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ServerInfo } from '../../src/server.ts';
import { childEnv } from '../../src/testing/child-env.ts';

type Ready = ServerInfo & { event: 'ready' };

const root = resolve(import.meta.dirname, '..', '..');
const cli = join(root, 'dist', 'bin', 'admin-sdk-mock.js');
const limits = {
  timeout: 120_000,
  killSignal: 'SIGKILL',
  encoding: 'utf8',
} as const;
const results: { name: string; ok: boolean; note: string }[] = [];

function record(name: string, ok: boolean, note = ''): void {
  results.push({ name, ok, note });
}

function emails(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[^@\s]+@[^@\s]+$/.test(line));
}

/** Start the mock CLI and resolve with its ready event. */
async function startCli(
  tmp: string,
  config: string,
): Promise<{ child: ChildProcess; ready: Ready }> {
  const child = spawn(
    process.execPath,
    [
      cli,
      'start',
      '--config',
      config,
      '--data-dir',
      join(tmp, 'data'),
      '--google-port',
      '0',
      '--control-port',
      '0',
      '--proxy-port',
      '0',
    ],
    // No MOCK_* or ADMIN_SDK_MOCK_* variables, so the developer's shell cannot steer the mock.
    { cwd: tmp, env: childEnv(), stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: child.stdout! });
  const exited = once(child, 'exit').then(([code]) => {
    throw new Error(`The mock exited with code ${code} before it was ready.`);
  });
  const ready = new Promise<Ready>((resolveReady) => {
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event.event === 'ready') resolveReady(event);
      } catch {
        // Ignore lines that are not JSON.
      }
    });
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error('The mock was not ready in 60 s.')),
      60000,
    ).unref(),
  );
  try {
    return { child, ready: await Promise.race([ready, exited, timeout]) };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  await closed;
  clearTimeout(timer);
}

function timedOut(run: { error?: Error }): boolean {
  return (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
}

function runNodeTest(name: string, file: string): void {
  const run = spawnSync(
    process.execPath,
    ['--test', '--test-timeout=60000', file],
    { cwd: root, ...limits },
  );
  const ok = run.status === 0;
  if (!ok) process.stderr.write(run.stdout + run.stderr);
  record(
    name,
    ok,
    ok ? '' : timedOut(run) ? 'timed out after 120 s' : 'node --test failed',
  );
}

async function runCliExamples(tmp: string): Promise<void> {
  let child: ChildProcess | undefined;
  try {
    const config = join(tmp, 'admin-sdk-mock.json');
    copyFileSync(
      join(root, 'examples', 'node-cli', 'admin-sdk-mock.json'),
      config,
    );
    const started = await startCli(tmp, config);
    child = started.child;
    const ready = started.ready;
    const domain = ready.domains[0];
    const controlUrl = `http://${ready.listeners.control.host}:${ready.listeners.control.port}`;
    const envRun = spawnSync(
      process.execPath,
      [cli, 'env', '--control', controlUrl, '--format', 'json'],
      { cwd: tmp, env: childEnv(), ...limits },
    );
    if (envRun.status !== 0)
      throw new Error(
        timedOut(envRun)
          ? 'env timed out after 120 s'
          : `env failed: ${envRun.stderr}`,
      );
    const clientEnv = JSON.parse(envRun.stdout) as Record<string, string>;
    const env = {
      ...process.env,
      ...clientEnv,
      GOOGLE_APPLICATION_CREDENTIALS: domain.serviceAccounts[0].out,
      ADMIN_SUBJECT: domain.adminEmail,
    };

    const list = spawnSync(
      process.execPath,
      ['examples/node-cli/list-users.mjs'],
      {
        cwd: root,
        env,
        ...limits,
      },
    );
    const found = emails(list.stdout);
    const cliOk = list.status === 0 && found.length === 5;
    if (!cliOk) process.stderr.write(list.stdout + list.stderr);
    record(
      'node-cli',
      cliOk,
      cliOk
        ? ''
        : timedOut(list)
          ? 'timed out after 120 s'
          : `${found.length} emails, exit ${list.status}`,
    );

    const curl = spawnSync('curl', ['--version'], limits);
    if (curl.error || curl.status !== 0) {
      console.log('curl is not on the path. Skipping the curl example.');
      return;
    }
    const run = spawnSync(
      'bash',
      ['examples/curl/list-users.sh', domain.customerId],
      {
        cwd: root,
        env: { ...env, ADMIN_SDK_MOCK: `${process.execPath} ${cli}` },
        ...limits,
      },
    );
    const curlOk = run.status === 0 && run.stdout.includes('"primaryEmail"');
    if (!curlOk) process.stderr.write(run.stdout + run.stderr);
    record(
      'curl',
      curlOk,
      curlOk
        ? ''
        : timedOut(run)
          ? 'timed out after 120 s'
          : `exit ${run.status}`,
    );
  } catch (error) {
    for (const name of ['node-cli', 'curl'])
      if (!results.some((result) => result.name === name))
        record(name, false, (error as Error).message);
  } finally {
    await stop(child);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'examples-'));
try {
  runNodeTest('node-in-process', 'examples/node-in-process/directory.test.mjs');
  runNodeTest('fixtures', 'examples/fixtures/fixtures.test.mjs');
  await runCliExamples(tmp);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const result of results)
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.note ? ` (${result.note})` : ''}`,
  );
process.exit(results.some((result) => !result.ok) ? 1 : 0);
