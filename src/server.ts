import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type https from 'node:https';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import tls from 'node:tls';
import {
  findConfigFile,
  loadConfigFile,
  resolveConfig,
  type ConfigFlags,
  type MockConfig,
} from './config/config.ts';
import { createControlHandler } from './control/control.ts';
import { createMock, type Mock } from './mock.ts';
import { startProxy, type ProxyHandle } from './proxy.ts';
import { ensureDomain, type EnsuredDomain } from './startup/ensure-domains.ts';
import { VERSION } from './version.ts';

export interface ServerInfo {
  version: string;
  ready: boolean;
  listeners: {
    google: { host: string; port: number };
    control: { host: string; port: number };
    proxy: { host: string; port: number; passthrough: boolean } | null;
  };
  caFile: string;
  caBundleFile: string;
  dataDir: string;
  domains: EnsuredDomain[];
}

export interface ServerHandle {
  readonly mock: Mock;
  info(): ServerInfo;
  /** Record a domain that was ensured after startup, so info() and GET /info list it. */
  addDomain(domain: EnsuredDomain): void;
  readonly controlUrl: string;
  readonly googleUrl: string;
  readonly proxy: ProxyHandle | null;
  close(): Promise<void>;
}

const NO_PROXY = 'localhost,127.0.0.1,::1';

/** The address a client dials for a listener host. A wildcard address becomes loopback. */
const dialable = (host: string) =>
  host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

/** A listener host as it appears in a URL, with an IPv6 address bracketed. */
const urlHost = (host: string) => {
  const name = dialable(host);
  return name.includes(':') ? `[${name}]` : name;
};

/** The CA bundle path: the CA file name with `.pem` replaced by `-bundle.pem`. */
const bundlePath = (caFile: string) =>
  `${caFile.endsWith('.pem') ? caFile.slice(0, -'.pem'.length) : caFile}-bundle.pem`;

/** Write a file in one step: write a temporary file beside it, then rename it into place. */
function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.tmp`,
  );
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

async function closeServer(server: http.Server | https.Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  server.closeAllConnections();
  await once(server, 'close');
}

/**
 * Build the whole running mock from a resolved configuration: the CA files, the Google,
 * control, and proxy listeners, the ensured domains, and the ready file. When a step
 * fails, everything opened so far is closed before the error is rethrown.
 */
export async function startServer(
  config: MockConfig,
  options: { log?: (event: Record<string, unknown>) => void } = {},
): Promise<ServerHandle> {
  const log = options.log ?? (() => undefined);
  const mock = createMock({
    dataDir: config.dataDir,
    timing: { ...config.timing },
  });
  const caFile = config.caFile;
  const caBundleFile = bundlePath(caFile);
  const domains: EnsuredDomain[] = [];
  let google: https.Server | undefined;
  let control: http.Server | undefined;
  let proxy: ProxyHandle | null = null;
  let googlePort = 0;
  let controlPort = 0;
  let ready = false;
  let closing: Promise<void> | undefined;

  const close = () =>
    (closing ??= (async () => {
      await proxy?.close();
      if (control) await closeServer(control);
      if (google) await closeServer(google);
      mock.close();
    })());

  const info = (): ServerInfo => ({
    version: VERSION,
    ready,
    listeners: {
      google: { host: config.listen.google.host, port: googlePort },
      control: { host: config.listen.control.host, port: controlPort },
      proxy:
        proxy && config.listen.proxy
          ? {
              host: proxy.host,
              port: proxy.port,
              passthrough: config.listen.proxy.passthrough,
            }
          : null,
    },
    caFile,
    caBundleFile,
    dataDir: config.dataDir,
    domains: structuredClone(domains),
  });

  try {
    if (config.readyFile) rmSync(config.readyFile, { force: true });
    const caCert = mock.certificates.caCert;
    mkdirSync(dirname(caFile), { recursive: true });
    writeFileSync(caFile, caCert, { mode: 0o644 });
    writeFileSync(
      caBundleFile,
      `${caCert.trimEnd()}\n${tls.rootCertificates.join('\n')}\n`,
      { mode: 0o644 },
    );

    google = await mock.listenGoogle(
      config.listen.google.port,
      config.listen.google.host,
    );
    googlePort = (google.address() as AddressInfo).port;

    control = http.createServer(createControlHandler(mock, { info }));
    control.listen(config.listen.control.port, config.listen.control.host);
    await once(control, 'listening');
    controlPort = (control.address() as AddressInfo).port;

    if (config.listen.proxy)
      proxy = await startProxy({
        host: config.listen.proxy.host,
        port: config.listen.proxy.port,
        passthrough: config.listen.proxy.passthrough,
        target: { host: dialable(config.listen.google.host), port: googlePort },
        log,
      });

    log({
      event: 'started',
      version: VERSION,
      googlePort,
      controlPort,
      proxyPort: proxy?.port ?? null,
      dataDir: config.dataDir,
      caFile,
      timing: { ...mock.timing },
    });

    config.domains.forEach((entry, index) => {
      const startedAt = Date.now();
      const ensured = ensureDomain(
        mock,
        entry,
        index,
        config.defaults.settings,
        mock.clock.now(),
      );
      domains.push(ensured);
      log({
        event: 'domain',
        customerId: ensured.customerId,
        primaryDomain: ensured.primaryDomain,
        action: ensured.action,
        durationMs: Date.now() - startedAt,
      });
    });

    ready = true;
    const event = { event: 'ready', ...info() };
    if (config.readyFile)
      writeAtomically(config.readyFile, `${JSON.stringify(event, null, 2)}\n`);
    log(event);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    mock,
    info,
    addDomain(domain) {
      const at = domains.findIndex((d) => d.customerId === domain.customerId);
      if (at === -1) domains.push(structuredClone(domain));
      else domains[at] = structuredClone(domain);
    },
    controlUrl: `http://${urlHost(config.listen.control.host)}:${controlPort}`,
    googleUrl: `https://${urlHost(config.listen.google.host)}:${googlePort}`,
    proxy,
    close,
  };
}

/**
 * Find and resolve the startup configuration: the flag, then MOCK_CONFIG, then
 * ./admin-sdk-mock.json, then MOCK_CONFIG_DEFAULT when that file exists.
 */
export function loadStartupConfig(input: {
  flags?: ConfigFlags;
  configFlag?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): MockConfig {
  let file = findConfigFile({
    flag: input.configFlag,
    env: input.env,
    cwd: input.cwd,
  });
  const fallback = input.env.MOCK_CONFIG_DEFAULT;
  if (!file && fallback && existsSync(resolve(input.cwd, fallback)))
    file = resolve(input.cwd, fallback);
  return resolveConfig({
    file: file ? loadConfigFile(file) : undefined,
    fileDir: file ? dirname(file) : undefined,
    env: input.env,
    flags: input.flags,
    cwd: input.cwd,
  });
}

/** The environment that points a client under test at a running mock. */
export function clientEnvironment(
  info: ServerInfo,
  controlUrl: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  const proxy = info.listeners.proxy;
  if (proxy) {
    const url = `http://${urlHost(proxy.host)}:${proxy.port}`;
    environment.HTTPS_PROXY = url;
    environment.https_proxy = url;
  }
  Object.assign(environment, {
    NO_PROXY,
    no_proxy: NO_PROXY,
    NODE_EXTRA_CA_CERTS: info.caFile,
    SSL_CERT_FILE: info.caBundleFile,
    REQUESTS_CA_BUNDLE: info.caBundleFile,
    HTTPLIB2_CA_CERTS: info.caBundleFile,
    CURL_CA_BUNDLE: info.caBundleFile,
    ADMIN_SDK_MOCK_CONTROL: controlUrl,
  });
  const accounts = info.domains.flatMap((domain) => domain.serviceAccounts);
  if (accounts.length === 1)
    environment.GOOGLE_APPLICATION_CREDENTIALS = accounts[0].out;
  return environment;
}
