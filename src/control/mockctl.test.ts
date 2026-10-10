import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { childEnv } from '../testing/child-env.ts';
import { startHarness } from '../testing/harness.ts';
import { createControlHandler } from './control.ts';

const run = promisify(execFile);

test('mockctl creates a domain, issues a credential file, and sets the clock', async (t) => {
  const harness = await startHarness();
  const server = http.createServer(createControlHandler(harness.mock));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await harness.close();
  });
  const env = {
    ...childEnv(),
    MOCK_CONTROL_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
  const ctl = (...args: string[]) =>
    run(process.execPath, ['bin/mockctl.ts', ...args], { env });

  const created = JSON.parse(
    (
      await ctl(
        'domain',
        'create',
        '--tier',
        'small',
        '--seed',
        'cli',
        '--counts',
        '{"schools":1,"students":30,"staff":5,"devices":20}',
      )
    ).stdout,
  );
  assert.match(created.customerId, /^C0/);
  const file = join(harness.dataDir, 'credential.json');
  const written = JSON.parse(
    (await ctl('credential', created.customerId, '--out', file)).stdout,
  );
  assert.equal(written.written, file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).type, 'service_account');
  const existing = join(harness.dataDir, 'existing-credential.json');
  writeFileSync(existing, 'old', { mode: 0o644 });
  chmodSync(existing, 0o644);
  const before = statSync(existing).ino;
  await ctl('credential', created.customerId, '--out', existing);
  assert.equal(statSync(existing).mode & 0o777, 0o600);
  assert.notEqual(statSync(existing).ino, before);
  assert.deepEqual(
    readdirSync(harness.dataDir).filter((name) => name.endsWith('.tmp')),
    [],
  );
  assert.deepEqual(JSON.parse((await ctl('clock', '--scale', '60')).stdout), {
    scale: 60,
    delays: false,
  });
  for (const bad of ['yes', 'ON', 'true', ''])
    await assert.rejects(
      ctl('clock', '--delays', bad),
      (error: { code?: number; stderr?: string }) =>
        error.code === 1 &&
        /--delays must be on or off/.test(error.stderr ?? ''),
      bad,
    );
  assert.equal(
    JSON.parse((await ctl('clock', '--delays', 'on')).stdout).delays,
    true,
  );
  assert.equal(
    JSON.parse((await ctl('clock', '--delays', 'off')).stdout).delays,
    false,
  );
  await assert.rejects(ctl('domain', 'show', 'C0missing'), /404/);
  await assert.rejects(ctl('nonsense'), /Usage: mockctl/);
  assert.match((await ctl('--help')).stdout, /^Usage: mockctl <command>/);
});

test('mockctl flushes the search index of a domain', async (t) => {
  const harness = await startHarness();
  const server = http.createServer(createControlHandler(harness.mock));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await harness.close();
  });
  const env = {
    ...childEnv(),
    MOCK_CONTROL_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
  const ctl = (...args: string[]) =>
    run(process.execPath, ['bin/mockctl.ts', ...args], { env });
  const created = JSON.parse(
    (
      await ctl(
        'domain',
        'create',
        '--tier',
        'small',
        '--seed',
        'flush',
        '--counts',
        '{"schools":1,"students":30,"staff":5,"devices":20}',
      )
    ).stdout,
  );
  assert.deepEqual(
    JSON.parse((await ctl('index', 'flush', created.customerId)).stdout),
    { flushed: 0, delaysEnded: 0 },
  );
  await assert.rejects(ctl('index', 'flush'), /A customer ID is required/);
});
