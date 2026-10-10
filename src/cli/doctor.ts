import { accessSync, constants, existsSync, statSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, type MockConfig } from '../config/config.ts';
import { loadStartupConfig, startupConfigFile } from '../server.ts';
import type { Io } from './main.ts';

const MINIMUM_NODE = [24, 11] as const;

/**
 * Whether the process can write the path: the path itself when it exists, or else the
 * nearest existing directory above it, where the mock creates the missing directories.
 */
function writable(path: string, directory: boolean): boolean {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current)) {
      const isDirectory = statSync(current).isDirectory();
      if (current === path ? isDirectory !== directory : !isDirectory)
        return false;
      try {
        accessSync(current, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    if (dirname(current) === current) return false;
  }
}

/** Bind and release the port. Resolve null when it binds, or the error code when it does not. */
function bindError(host: string, port: number): Promise<string | null> {
  if (port === 0) return Promise.resolve(null);
  return new Promise((done) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) =>
      done(error.code ?? error.message),
    );
    server.listen({ host, port }, () => server.close(() => done(null)));
  });
}

/** Check Node.js, the configuration, the data directory, the CA file, and the ports. */
export async function runDoctor(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { config: { type: 'string' } },
  });
  let failed = false;
  const report = (pass: boolean, text: string) => {
    failed ||= !pass;
    io.stdout(`${pass ? 'PASS' : 'FAIL'} ${text}\n`);
  };

  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  const [needMajor, needMinor] = MINIMUM_NODE;
  const supported =
    major > needMajor || (major === needMajor && minor >= needMinor);
  report(
    supported,
    `Node.js ${version} ${supported ? 'satisfies' : 'does not satisfy'} >=${needMajor}.${needMinor}.`,
  );

  const file = startupConfigFile({
    configFlag: values.config,
    env: io.env,
    cwd: io.cwd,
  });
  const label = file ? `Configuration ${file}` : 'Configuration';
  let config: MockConfig;
  try {
    config = loadStartupConfig({
      configFlag: values.config,
      env: io.env,
      cwd: io.cwd,
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    for (const line of error.errors) report(false, `${label}: ${line}`);
    return 1;
  }
  if (file) report(true, `${label} is valid.`);

  const dataDir = writable(config.dataDir, true);
  report(
    dataDir,
    `Data directory ${config.dataDir} is ${dataDir ? '' : 'not '}writable.`,
  );
  const caFile = writable(config.caFile, false);
  report(
    caFile,
    `CA file ${config.caFile} is ${caFile ? '' : 'not '}writable.`,
  );

  const listeners = [
    ['Google', config.listen.google],
    ['Control', config.listen.control],
    ['Proxy', config.listen.proxy],
  ] as const;
  for (const [name, address] of listeners) {
    if (!address) continue;
    const where = `${name} listener ${address.host}:${address.port}`;
    const error = await bindError(address.host, address.port);
    if (error === null)
      report(
        true,
        address.port === 0
          ? `${where} picks a free port.`
          : `${where} is free.`,
      );
    else if (error === 'EADDRINUSE') report(false, `${where} is in use.`);
    else report(false, `${where} cannot bind (${error}).`);
  }
  return failed ? 1 : 0;
}
