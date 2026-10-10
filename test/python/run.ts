import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfig } from '../../src/config/config.ts';
import { clientEnvironment, startServer } from '../../src/server.ts';

const root = resolve(import.meta.dirname, '..', '..');
const python = process.env.PYTHON ?? 'python3';

const check = spawnSync(
  python,
  ['-c', 'import googleapiclient, google.oauth2, google_auth_httplib2, socks'],
  { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' },
);
if (check.error) {
  console.error(`Could not run ${python}: ${check.error.message}`);
  process.exit(1);
}
if (check.status !== 0) {
  console.error(
    'Install examples/python/requirements.txt into the active Python first.',
  );
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'python-example-'));
let failure: string | null = null;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  server = await startServer(
    resolveConfig({
      cwd: tmp,
      file: {
        dataDir: join(tmp, 'data'),
        listen: {
          google: { port: 0 },
          control: { port: 0 },
          proxy: { port: 0 },
        },
        domains: [
          {
            spec: {
              tier: 'small',
              seed: 'python',
              counts: { schools: 1, students: 20, staff: 5, devices: 5 },
            },
            serviceAccounts: [{ out: join(tmp, 'key.json'), scopes: 'read' }],
          },
        ],
      },
    }),
  );
  const info = server.info();
  const domain = info.domains[0];
  // The server runs in this process, so the script must run without blocking the event loop.
  const run = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((done, fail) => {
    const child = spawn(python, ['examples/python/list_users.py'], {
      cwd: root,
      env: {
        ...process.env,
        ...clientEnvironment(info, server!.controlUrl),
        GOOGLE_APPLICATION_CREDENTIALS: domain.serviceAccounts[0].out,
        ADMIN_SUBJECT: domain.adminEmail,
      },
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error('The script did not finish in 120 s.'));
    }, 120_000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', fail);
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
  const emails = run.stdout
    .split('\n')
    .filter((line) => /^[^@\s]+@[^@\s]+$/.test(line.trim()));
  const accepted = server.proxy?.accepted.length ?? 0;
  const refused = server.proxy?.refused.length ?? 0;
  if (run.status !== 0)
    failure = `The script exited with ${run.status}.\n${run.stderr}`;
  else if (emails.length !== 5)
    failure = `The script printed ${emails.length} emails, not 5.`;
  else if (accepted < 1) failure = 'The proxy accepted no CONNECT.';
  else if (refused > 0) failure = `The proxy refused ${refused} targets.`;
  else console.log(`PASS python (5 emails, ${accepted} CONNECT accepted)`);
} catch (error) {
  failure = (error as Error).message;
} finally {
  await server?.close();
  rmSync(tmp, { recursive: true, force: true });
}
if (failure) {
  console.error(`FAIL python: ${failure}`);
  process.exit(1);
}
