/** The programmatic API of the Admin SDK mock. */
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import tls from 'node:tls';
import { issueServiceAccount } from './auth/accounts.ts';
import { resolveConfig, scopesFor } from './config/config.ts';
import type { MockConfig } from './config/config.ts';
import { loadFixtures, parseFixtures } from './seed/fixtures.ts';
import { clientEnvironment, startServer } from './server.ts';
import type { ServerInfo } from './server.ts';
import { ensureDomain } from './startup/ensure-domains.ts';
import type { EnsuredDomain } from './startup/ensure-domains.ts';

export { VERSION } from './version.ts';
export { READ_SCOPES, READ_WRITE_SCOPES } from './auth/scopes.ts';
export type { MockConfig, EnsuredDomain, ServerInfo };
export type { Fixtures } from './seed/fixtures.ts';

type ScopeSet = 'read' | 'read-write' | string[];

export interface MockOptions {
  dataDir?: string;
  config?: Record<string, unknown>;
  proxy?: false | { passthrough?: boolean };
  timing?: { scale?: number; delays?: boolean };
  log?: (event: Record<string, unknown>) => void;
}

export interface MockHandle {
  readonly googleUrl: string;
  readonly controlUrl: string;
  readonly proxyUrl: string | null;
  readonly caCert: string;
  readonly caFile: string;
  readonly caBundleFile: string;
  readonly domains: readonly EnsuredDomain[];
  createDomain(
    spec: Record<string, unknown>,
    options?: {
      settings?: Record<string, unknown>;
      fixtures?: string | Record<string, unknown>;
    },
  ): Promise<EnsuredDomain>;
  credential(customerId: string, scopes?: ScopeSet): Record<string, string>;
  token(
    customerId: string,
    options?: { subject?: string; scopes?: ScopeSet },
  ): Promise<string>;
  env(): Record<string, string>;
  useInProcess(): () => void;
  flush(customerId: string): Promise<unknown>;
  control(method: string, path: string, body?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

interface Installed {
  caCert: string;
  proxyUrl: string;
}

/** The process state to restore, captured when the first handle installs. */
let baseline: {
  ca: string[];
  httpsProxy: string | undefined;
  httpsProxyLower: string | undefined;
} | null = null;
const active: Installed[] = [];

function setOrDelete(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Recompute the trusted CA set and the proxy variables from the active handles. */
function applyActive(): void {
  if (!baseline) return;
  tls.setDefaultCACertificates([
    ...baseline.ca,
    ...active.map((handle) => handle.caCert),
  ]);
  const last = active.at(-1);
  setOrDelete('HTTPS_PROXY', last ? last.proxyUrl : baseline.httpsProxy);
  setOrDelete('https_proxy', last ? last.proxyUrl : baseline.httpsProxyLower);
  if (!last) baseline = null;
}

function install(handle: Installed): () => void {
  baseline ??= {
    ca: tls.getCACertificates('default'),
    httpsProxy: process.env.HTTPS_PROXY,
    httpsProxyLower: process.env.https_proxy,
  };
  active.push(handle);
  applyActive();
  return () => {
    const at = active.indexOf(handle);
    if (at === -1) return;
    active.splice(at, 1);
    applyActive();
  };
}

/** Start a mock in this process with a temporary data directory unless one is given. */
export async function startMock(
  options: MockOptions = {},
): Promise<MockHandle> {
  const given = options.config ?? {};
  const callerDir = options.dataDir ?? (given.dataDir as string | undefined);
  const ownsDataDir = callerDir === undefined;
  const dataDir = callerDir ?? mkdtempSync(join(tmpdir(), 'admin-sdk-mock-'));
  const givenListen = (given.listen ?? {}) as Record<string, unknown>;
  const merge = (defaults: object, over: unknown) =>
    over === undefined
      ? { ...defaults }
      : typeof over === 'object' && over !== null && !Array.isArray(over)
        ? { ...defaults, ...over }
        : over;
  const file = {
    ...given,
    dataDir,
    listen: {
      ...givenListen,
      google: merge({ host: '127.0.0.1', port: 0 }, givenListen.google),
      control: merge({ host: '127.0.0.1', port: 0 }, givenListen.control),
      proxy:
        options.proxy === false
          ? null
          : merge(
              {
                host: '127.0.0.1',
                port: 0,
                passthrough: options.proxy?.passthrough ?? true,
              },
              givenListen.proxy,
            ),
    },
    timing: {
      scale: 1,
      delays: false,
      ...(given.timing as object | undefined),
      ...options.timing,
    },
  };
  const cleanup = () => {
    if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
  };

  let server;
  try {
    const config = resolveConfig({
      file,
      fileDir: process.cwd(),
      env: {},
      cwd: process.cwd(),
    });
    server = await startServer(config, { log: options.log });
  } catch (error) {
    cleanup();
    throw error;
  }

  const initial = server.info();
  const proxyUrl = server.proxy ? server.proxy.url : null;
  // Node reports trusted certificates with LF line endings, so normalize the PEM the same way.
  const caCert = new X509Certificate(
    server.mock.certificates.caCert,
  ).toString();
  const undos = new Set<() => void>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const control = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const response = await fetch(`${server.controlUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `${method} ${path} failed with status ${response.status}: ${text}`,
      );
    return text === '' ? null : JSON.parse(text);
  };

  const handle: MockHandle = {
    googleUrl: server.googleUrl,
    controlUrl: server.controlUrl,
    proxyUrl,
    caCert,
    caFile: initial.caFile,
    caBundleFile: initial.caBundleFile,
    get domains() {
      return server.info().domains;
    },

    async createDomain(spec, domainOptions = {}) {
      let fixturesFile: string | null = null;
      let scratch: string | undefined;
      const fixtures = domainOptions.fixtures;
      if (typeof fixtures === 'string') {
        fixturesFile = resolve(fixtures);
        loadFixtures(fixturesFile);
      } else if (fixtures !== undefined) {
        parseFixtures(fixtures, 'inline fixtures');
        scratch = mkdtempSync(join(tmpdir(), 'admin-sdk-mock-fixtures-'));
        fixturesFile = join(scratch, 'fixtures.json');
        writeFileSync(fixturesFile, JSON.stringify(fixtures));
      }
      try {
        const ensured = ensureDomain(
          server.mock,
          {
            spec,
            onStart: 'keep',
            settings: domainOptions.settings ?? {},
            fixtures: fixturesFile,
            serviceAccounts: [],
            faults: [],
          },
          server.info().domains.length,
          {},
          server.mock.clock.now(),
        );
        server.addDomain(ensured);
        return structuredClone(ensured);
      } finally {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      }
    },

    credential(customerId, scopes = 'read-write') {
      const key = issueServiceAccount(server.mock.registry, customerId);
      server.mock.registry.setGrant(
        customerId,
        key.client_id,
        scopesFor(scopes),
      );
      return { ...key };
    },

    async token(customerId, tokenOptions = {}) {
      const result = (await control(
        'POST',
        `/domains/${encodeURIComponent(customerId)}/tokens`,
        { ...tokenOptions },
      )) as { access_token: string };
      return result.access_token;
    },

    env() {
      return clientEnvironment(server.info(), server.controlUrl);
    },

    useInProcess() {
      if (closed) throw new Error('The mock is closed.');
      if (proxyUrl === null)
        throw new Error(
          'The proxy is off. Start the mock with a proxy to use it in process.',
        );
      const undo = install({ caCert, proxyUrl });
      undos.add(undo);
      return undo;
    },

    flush(customerId) {
      return control(
        'POST',
        `/domains/${encodeURIComponent(customerId)}/index/flush`,
      );
    },

    control,

    close() {
      return (closing ??= (async () => {
        closed = true;
        for (const undo of undos) undo();
        try {
          await server.close();
        } finally {
          cleanup();
        }
      })());
    },
  };
  return handle;
}
