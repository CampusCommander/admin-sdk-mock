import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { isolatedChild } from './testing/child-env.ts';

const MAIN = fileURLToPath(new URL('main.ts', import.meta.url));
const WAIT_MS = 60_000;

/** Spawn the `npm start` entry point in an empty directory, without the parent's MOCK_* variables. */
function spawnMain(
  t: TestContext,
  env: NodeJS.ProcessEnv,
  stderr: 'inherit' | 'pipe' = 'inherit',
): ChildProcess {
  const isolated = isolatedChild('main-cwd-');
  const child = spawn(process.execPath, [MAIN], {
    cwd: isolated.cwd,
    env: { ...isolated.env, ...env },
    stdio: ['ignore', 'pipe', stderr],
  });
  t.after(() => {
    child.kill('SIGKILL');
    isolated.remove();
  });
  return child;
}

/**
 * Read standard output lines until `last` accepts one. Rejects when the child exits first or
 * after WAIT_MS, so a mock that fails to start fails the test instead of hanging it.
 */
function linesUntil(
  child: ChildProcess,
  last: (line: string) => boolean,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const reader = createInterface({ input: child.stdout! });
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      reader.off('line', onLine);
      if (error) reject(error);
      else resolve(lines);
    };
    const onLine = (line: string) => {
      lines.push(line);
      if (last(line)) finish();
    };
    const onExit = (code: number | null) =>
      finish(new Error(`The mock exited with code ${code} first.`));
    const timer = setTimeout(
      () =>
        finish(new Error(`The mock wrote no matching line in ${WAIT_MS} ms.`)),
      WAIT_MS,
    );
    reader.on('line', onLine);
    child.once('exit', onExit);
  });
}

test('the entry point starts both listeners, exports the CA, and stops on SIGTERM', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'main-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const caExport = join(dataDir, 'public', 'ca.pem');
  const child = spawnMain(t, {
    MOCK_DATA_DIR: dataDir,
    MOCK_GOOGLE_PORT: '0',
    MOCK_GOOGLE_HOST: '127.0.0.1',
    MOCK_CONTROL_PORT: '0',
    MOCK_CA_EXPORT: caExport,
    MOCK_DELAYS: 'off',
  });
  const [line] = await linesUntil(child, () => true);
  const started = JSON.parse(line);
  assert.equal(started.event, 'started');
  assert.ok(started.googlePort > 0 && started.controlPort > 0);
  assert.deepEqual(started.timing, { scale: 1, delays: false });
  const health = await fetch(`http://127.0.0.1:${started.controlPort}/health`);
  assert.equal(health.status, 200);
  assert.match(readFileSync(caExport, 'utf8'), /BEGIN CERTIFICATE/);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0);
});

test('an invalid configuration file exits with code 2 and names the problem', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'admin-sdk-mock.json');
  writeFileSync(
    config,
    JSON.stringify({ domains: [{ spec: { tier: 'huge', seed: 'x' } }] }),
  );
  const child = spawnMain(t, { MOCK_CONFIG: config }, 'pipe');
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => (stderr += chunk));
  const [code] = await once(child, 'exit');
  assert.equal(code, 2);
  assert.match(stderr, /domains\[0\]\.spec\.tier must be one of:/);
});

test('a configuration file starts its domains, logs ready, and stops on SIGTERM', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'admin-sdk-mock.json');
  writeFileSync(
    config,
    JSON.stringify({
      dataDir: './data',
      listen: { google: { port: 0 }, control: { port: 0 } },
      timing: { delays: false },
      domains: [{ spec: { tier: 'empty', seed: 'main' } }],
    }),
  );
  const child = spawnMain(t, { MOCK_CONFIG: config });
  const events = (
    await linesUntil(child, (line) => JSON.parse(line).event === 'ready')
  ).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    events.map((event) => event.event),
    ['started', 'domain', 'ready'],
  );
  assert.equal(events[0].dataDir, join(dir, 'data'));
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0);
});
