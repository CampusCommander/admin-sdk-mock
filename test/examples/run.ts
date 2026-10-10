import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ServerInfo } from '../../src/server.ts';

type Ready = ServerInfo & { event: 'ready' };

const root = resolve(import.meta.dirname, '..', '..');
const cli = join(root, 'dist', 'bin', 'admin-sdk-mock.js');
const exampleState = join(root, 'examples', 'node-cli', '.admin-sdk-mock');
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
): Promise<{ child: ChildProcess; ready: Ready }> {
  const child = spawn(
    process.execPath,
    [
      cli,
      'start',
      '--config',
      join(root, 'examples', 'node-cli', 'admin-sdk-mock.json'),
      '--data-dir',
      join(tmp, 'data'),
      '--google-port',
      '0',
      '--control-port',
      '0',
      '--proxy-port',
      '0',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
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
  return { child, ready: await Promise.race([ready, exited, timeout]) };
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  await closed;
  clearTimeout(timer);
}

function runNodeTests(): void {
  const run = spawnSync(
    process.execPath,
    [
      '--test',
      'examples/node-in-process/directory.test.mjs',
      'examples/fixtures/fixtures.test.mjs',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const ok = run.status === 0;
  if (!ok) process.stderr.write(run.stdout + run.stderr);
  record('node-in-process', ok, ok ? '' : 'node --test failed');
  record('fixtures', ok, ok ? '' : 'node --test failed');
}

async function runCliExamples(tmp: string): Promise<void> {
  let child: ChildProcess | undefined;
  try {
    const started = await startCli(tmp);
    child = started.child;
    const ready = started.ready;
    const domain = ready.domains[0];
    const controlUrl = `http://${ready.listeners.control.host}:${ready.listeners.control.port}`;
    const envRun = spawnSync(
      process.execPath,
      [cli, 'env', '--control', controlUrl, '--format', 'json'],
      { cwd: root, encoding: 'utf8' },
    );
    if (envRun.status !== 0) throw new Error(`env failed: ${envRun.stderr}`);
    const clientEnv = JSON.parse(envRun.stdout) as Record<string, string>;
    const env = {
      ...process.env,
      ...clientEnv,
      GOOGLE_APPLICATION_CREDENTIALS: resolve(
        root,
        'examples',
        'node-cli',
        domain.serviceAccounts[0].out,
      ),
      ADMIN_SUBJECT: domain.adminEmail,
    };

    const list = spawnSync(
      process.execPath,
      ['examples/node-cli/list-users.mjs'],
      {
        cwd: root,
        env,
        encoding: 'utf8',
      },
    );
    const found = emails(list.stdout);
    const cliOk = list.status === 0 && found.length === 5;
    if (!cliOk) process.stderr.write(list.stdout + list.stderr);
    record(
      'node-cli',
      cliOk,
      cliOk ? '' : `${found.length} emails, exit ${list.status}`,
    );

    const curl = spawnSync('curl', ['--version'], { encoding: 'utf8' });
    if (curl.error || curl.status !== 0) {
      console.log('curl is not on the path. Skipping the curl example.');
      return;
    }
    const wrapperDir = mkdtempSync(join(tmp, 'wrapper-'));
    const wrapper = join(wrapperDir, 'admin-sdk-mock');
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\nexport MOCK_CONTROL_URL=${JSON.stringify(controlUrl)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const run = spawnSync(
      'bash',
      ['examples/curl/list-users.sh', domain.customerId],
      {
        cwd: root,
        env: { ...env, PATH: `${wrapperDir}${delimiter}${process.env.PATH}` },
        encoding: 'utf8',
      },
    );
    const curlOk = run.status === 0 && run.stdout.includes('"primaryEmail"');
    if (!curlOk) process.stderr.write(run.stdout + run.stderr);
    record('curl', curlOk, curlOk ? '' : `exit ${run.status}`);
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
  runNodeTests();
  await runCliExamples(tmp);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(exampleState, { recursive: true, force: true });
}

for (const result of results)
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.note ? ` (${result.note})` : ''}`,
  );
process.exit(results.some((result) => !result.ok) ? 1 : 0);
