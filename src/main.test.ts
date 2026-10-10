import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

test('the entry point starts both listeners, exports the CA, and stops on SIGTERM', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'main-'));
  const caExport = join(dataDir, 'public', 'ca.pem');
  const child = spawn(process.execPath, ['src/main.ts'], {
    env: {
      ...process.env,
      MOCK_DATA_DIR: dataDir,
      MOCK_GOOGLE_PORT: '0',
      MOCK_GOOGLE_HOST: '127.0.0.1',
      MOCK_CONTROL_PORT: '0',
      MOCK_CA_EXPORT: caExport,
      MOCK_DELAYS: 'off',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const [line] = (await once(
      createInterface({ input: child.stdout! }),
      'line',
    )) as [string];
    const started = JSON.parse(line);
    assert.equal(started.event, 'started');
    assert.ok(started.googlePort > 0 && started.controlPort > 0);
    assert.deepEqual(started.timing, { scale: 1, delays: false });
    const health = await fetch(
      `http://127.0.0.1:${started.controlPort}/health`,
    );
    assert.equal(health.status, 200);
    assert.match(readFileSync(caExport, 'utf8'), /BEGIN CERTIFICATE/);
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  } finally {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an invalid configuration file exits with code 2 and names the problem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-'));
  const config = join(dir, 'admin-sdk-mock.json');
  writeFileSync(
    config,
    JSON.stringify({ domains: [{ spec: { tier: 'huge', seed: 'x' } }] }),
  );
  const child = spawn(process.execPath, ['src/main.ts'], {
    env: { ...process.env, MOCK_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => (stderr += chunk));
    const [code] = await once(child, 'exit');
    assert.equal(code, 2);
    assert.match(stderr, /domains\[0\]\.spec\.tier must be one of:/);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a configuration file starts its domains, logs ready, and stops on SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-'));
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
  const child = spawn(process.execPath, ['src/main.ts'], {
    env: { ...process.env, MOCK_CONFIG: config },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const events: Record<string, unknown>[] = [];
    for await (const line of createInterface({ input: child.stdout! })) {
      events.push(JSON.parse(line));
      if (events.at(-1)!.event === 'ready') break;
    }
    assert.deepEqual(
      events.map((event) => event.event),
      ['started', 'domain', 'ready'],
    );
    assert.equal(events[0].dataDir, join(dir, 'data'));
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
