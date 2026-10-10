import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountError, checkProjectId } from '../auth/accounts.ts';
import {
  READ_SCOPES,
  READ_WRITE_SCOPES,
  SCOPE_PREFIX,
} from '../auth/scopes.ts';
import { parseTiming, TimingError } from '../clock.ts';
import { FaultError, validateFault } from '../faults/faults.ts';
import type { Mock } from '../mock.ts';
import { buildRoutes, faultTargets } from '../routes.ts';
import { resolveSpec, SpecError } from '../seed/spec.ts';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  SettingsError,
  type DomainSettings,
} from '../settings.ts';
import { validateSchema } from './json-schema.ts';

export interface ListenAddress {
  host: string;
  port: number;
}

export interface ProxyListen extends ListenAddress {
  passthrough: boolean;
}

export interface ServiceAccountEntry {
  out: string;
  scopes: 'read' | 'read-write' | string[];
  projectId?: string;
}

export interface DomainEntry {
  spec: Record<string, unknown>;
  onStart: 'keep' | 'reset';
  settings: Record<string, unknown>;
  fixtures: string | null;
  serviceAccounts: ServiceAccountEntry[];
  faults: unknown[];
}

export interface MockConfig {
  dataDir: string;
  listen: {
    google: ListenAddress;
    control: ListenAddress;
    proxy: ProxyListen | null;
  };
  timing: { scale: number; delays: boolean };
  caFile: string;
  readyFile: string | null;
  defaults: { settings: Record<string, unknown> };
  domains: DomainEntry[];
}

export type ConfigFlags = {
  dataDir?: string;
  googleHost?: string;
  googlePort?: number;
  controlHost?: string;
  controlPort?: number;
  proxyHost?: string;
  proxyPort?: number;
  passthrough?: boolean;
  scale?: number;
  delays?: boolean;
  caFile?: string;
  readyFile?: string;
};

/** The file shape once the schema accepts it. */
interface FileAddress {
  host?: string;
  port?: number;
}

interface ConfigFile {
  dataDir?: string;
  listen?: {
    google?: FileAddress;
    control?: FileAddress;
    proxy?: (FileAddress & { passthrough?: boolean }) | null;
  };
  timing?: { scale?: number; delays?: boolean };
  caFile?: string;
  readyFile?: string;
  defaults?: { settings?: Record<string, unknown> };
  domains?: {
    spec: Record<string, unknown>;
    onStart?: 'keep' | 'reset';
    settings?: Record<string, unknown>;
    fixtures?: string;
    serviceAccounts?: ServiceAccountEntry[];
    faults?: unknown[];
  }[];
}

const GOOGLE: ListenAddress = { host: '127.0.0.1', port: 8443 };
const CONTROL: ListenAddress = { host: '127.0.0.1', port: 8080 };
const PROXY: ListenAddress = { host: '127.0.0.1', port: 3128 };

/** Find schema/config.schema.json above this module, in the source tree or the installed package. */
function schemaPath(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, 'schema', 'config.schema.json');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir)
      throw new Error(`No schema/config.schema.json above ${start}.`);
  }
}

export const CONFIG_SCHEMA: Record<string, unknown> = JSON.parse(
  readFileSync(schemaPath(), 'utf8'),
) as Record<string, unknown>;

export class ConfigError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join('\n'));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

/** Read and parse a configuration file. A missing, unreadable, or malformed file is a ConfigError. */
export function loadConfigFile(path: string): unknown {
  if (!existsSync(path)) throw new ConfigError([`${path} does not exist.`]);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    throw new ConfigError([`${path} cannot be read: ${code ?? message}.`]);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError([
      `${path} is not valid JSON: ${(error as Error).message}`,
    ]);
  }
}

/** Find the configuration file: the flag, then MOCK_CONFIG, then ./admin-sdk-mock.json if present. */
export function findConfigFile(input: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  cwd: string;
}): string | null {
  if (input.flag) return resolve(input.cwd, input.flag);
  const named = input.env?.MOCK_CONFIG;
  if (named) return resolve(input.cwd, named);
  const local = join(input.cwd, 'admin-sdk-mock.json');
  return existsSync(local) ? local : null;
}

/** Run work, and record its error as `<label>: <message>` when it throws the given kind. */
function attempt<T>(
  errors: string[],
  kind: new (message: string) => Error,
  label: string,
  work: () => T,
): T | undefined {
  try {
    return work();
  } catch (error) {
    if (!(error instanceof kind)) throw error;
    errors.push(`${label}: ${error.message}`);
    return undefined;
  }
}

function checkPort(
  name: string,
  value: number,
  errors: string[],
): number | undefined {
  if (Number.isInteger(value) && value >= 0 && value <= 65_535) return value;
  errors.push(`${name} must be a whole number from 0 to 65535.`);
  return undefined;
}

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, inner]) => inner !== undefined),
  ) as T;

/** Read the MOCK_* overrides. An empty variable counts as unset. */
function readEnvironment(
  env: NodeJS.ProcessEnv,
  errors: string[],
): ConfigFlags {
  const text = (name: string): string | undefined =>
    env[name] === '' ? undefined : env[name];
  const port = (name: string): number | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    return checkPort(name, /^\d+$/.test(value) ? Number(value) : NaN, errors);
  };
  const flag = (name: string): boolean | undefined => {
    const value = text(name)?.toLowerCase();
    if (value === undefined) return undefined;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    errors.push(`${name} must be true, false, 1, or 0.`);
    return undefined;
  };
  const scale = text('MOCK_TIME_SCALE');
  const delays = text('MOCK_DELAYS');
  return defined({
    dataDir: text('MOCK_DATA_DIR'),
    googleHost: text('MOCK_GOOGLE_HOST'),
    googlePort: port('MOCK_GOOGLE_PORT'),
    controlHost: text('MOCK_CONTROL_HOST'),
    controlPort: port('MOCK_CONTROL_PORT'),
    proxyHost: text('MOCK_PROXY_HOST'),
    proxyPort: port('MOCK_PROXY_PORT'),
    passthrough: flag('MOCK_PROXY_PASSTHROUGH'),
    scale:
      scale === undefined
        ? undefined
        : attempt(
            errors,
            TimingError,
            'MOCK_TIME_SCALE',
            () => parseTiming(scale, undefined).scale,
          ),
    delays:
      delays === undefined
        ? undefined
        : attempt(
            errors,
            TimingError,
            'MOCK_DELAYS',
            () => parseTiming(undefined, delays).delays,
          ),
    caFile: text('MOCK_CA_EXPORT'),
    readyFile: text('MOCK_READY_FILE'),
  });
}

/** Check the numeric flags, named as the command line spells them. */
function checkFlags(flags: ConfigFlags, errors: string[]): ConfigFlags {
  const port = (name: string, value: number | undefined) =>
    value === undefined ? undefined : checkPort(name, value, errors);
  const scale = flags.scale;
  return defined({
    ...flags,
    googlePort: port('--google-port', flags.googlePort),
    controlPort: port('--control-port', flags.controlPort),
    proxyPort: port('--proxy-port', flags.proxyPort),
    scale:
      scale === undefined
        ? undefined
        : attempt(
            errors,
            TimingError,
            '--scale',
            () => parseTiming(String(scale), undefined).scale,
          ),
  });
}

/** The route IDs that a fault can target. buildRoutes reads the mock only inside handlers. */
let targets: readonly string[] | undefined;
const faultMethods = () =>
  (targets ??= faultTargets(buildRoutes(undefined as unknown as Mock)));

/** Check that a service account's scope list is not empty and holds Google scope URLs. */
function checkScopes(
  scopes: ServiceAccountEntry['scopes'],
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(scopes)) return;
  if (scopes.length === 0) errors.push(`${path} must list at least one scope.`);
  scopes.forEach((scope, n) => {
    if (!scope.startsWith(SCOPE_PREFIX))
      errors.push(`${path}[${n}] must be a Google scope URL.`);
  });
}

/**
 * The checks that need a schema-valid shape: specs, settings, fault rules, service accounts,
 * domains that share a customer ID or a domain name, and fixtures files.
 */
function checkDomains(config: MockConfig, errors: string[]): void {
  const defaults = attempt(
    errors,
    SettingsError,
    'defaults.settings',
    (): DomainSettings =>
      mergeSettings(DEFAULT_SETTINGS, config.defaults.settings),
  );
  const customers = new Map<string, number>();
  const names = new Map<string, number>();
  config.domains.forEach((entry, index) => {
    const path = `domains[${index}]`;
    const spec = attempt(errors, SpecError, `${path}.spec`, () =>
      resolveSpec(entry.spec),
    );
    if (defaults)
      attempt(errors, SettingsError, `${path}.settings`, () =>
        mergeSettings(defaults, entry.settings),
      );
    entry.faults.forEach((rule, n) =>
      attempt(errors, FaultError, `${path}.faults[${n}]`, () =>
        validateFault(rule, faultMethods()),
      ),
    );
    entry.serviceAccounts.forEach((account, n) => {
      const at = `${path}.serviceAccounts[${n}]`;
      checkScopes(account.scopes, `${at}.scopes`, errors);
      const { projectId } = account;
      if (projectId !== undefined)
        attempt(errors, AccountError, `${at}.projectId`, () =>
          checkProjectId(projectId),
        );
    });
    if (spec) {
      const first = customers.get(spec.customerId);
      const own = [
        ...new Set([spec.primaryDomain, spec.studentDomain, spec.aliasDomain]),
      ];
      const shared = own.find((name) => names.has(name));
      if (first !== undefined)
        errors.push(`${path}.spec names the same domain as domains[${first}].`);
      else if (shared !== undefined)
        errors.push(
          `${path}.spec uses the domain name ${shared} of domains[${names.get(shared)}]. Set another spec.name.`,
        );
      else {
        customers.set(spec.customerId, index);
        for (const name of own) names.set(name, index);
      }
    }
    if (entry.fixtures !== null && !existsSync(entry.fixtures))
      errors.push(`${path}.fixtures: ${entry.fixtures} does not exist.`);
  });
}

/**
 * Validate the configuration and resolve it with precedence: flags, then the environment,
 * then the file, then the defaults. File paths resolve against fileDir. Flag and environment
 * paths resolve against cwd. Every problem is collected and thrown as one ConfigError.
 */
export function resolveConfig(input: {
  file?: unknown;
  fileDir?: string;
  env?: NodeJS.ProcessEnv;
  flags?: ConfigFlags;
  cwd?: string;
}): MockConfig {
  const cwd = input.cwd ?? process.cwd();
  const fileDir = input.fileDir ?? cwd;
  const errors = validateSchema(CONFIG_SCHEMA, input.file ?? {});
  const shapeValid = errors.length === 0;
  const over: ConfigFlags = {
    ...readEnvironment(input.env ?? {}, errors),
    ...checkFlags(input.flags ?? {}, errors),
  };
  if (!shapeValid) throw new ConfigError(errors);

  const file = (input.file ?? {}) as ConfigFile;
  const fromFile = (path: string | undefined) =>
    path === undefined ? undefined : resolve(fileDir, path);
  const fromOverride = (path: string | undefined) =>
    path === undefined ? undefined : resolve(cwd, path);
  const address = (
    given: FileAddress | null | undefined,
    host: string | undefined,
    port: number | undefined,
    fallback: ListenAddress,
  ): ListenAddress => ({
    host: host ?? given?.host ?? fallback.host,
    port: port ?? given?.port ?? fallback.port,
  });

  const dataDir =
    fromOverride(over.dataDir) ??
    fromFile(file.dataDir) ??
    resolve(cwd, 'data');
  const proxy = file.listen?.proxy ?? null;
  const config: MockConfig = {
    dataDir,
    listen: {
      google: address(
        file.listen?.google,
        over.googleHost,
        over.googlePort,
        GOOGLE,
      ),
      control: address(
        file.listen?.control,
        over.controlHost,
        over.controlPort,
        CONTROL,
      ),
      proxy:
        proxy !== null || over.proxyPort !== undefined
          ? {
              ...address(proxy, over.proxyHost, over.proxyPort, PROXY),
              passthrough: over.passthrough ?? proxy?.passthrough ?? false,
            }
          : null,
    },
    timing: {
      scale: over.scale ?? file.timing?.scale ?? 1,
      delays: over.delays ?? file.timing?.delays ?? true,
    },
    caFile:
      fromOverride(over.caFile) ??
      fromFile(file.caFile) ??
      join(dataDir, 'ca', 'ca.pem'),
    readyFile: fromOverride(over.readyFile) ?? fromFile(file.readyFile) ?? null,
    defaults: { settings: file.defaults?.settings ?? {} },
    domains: (file.domains ?? []).map((entry) => ({
      spec: entry.spec,
      onStart: entry.onStart ?? 'keep',
      settings: entry.settings ?? {},
      fixtures: fromFile(entry.fixtures) ?? null,
      serviceAccounts: (entry.serviceAccounts ?? []).map((account) => ({
        ...account,
        out: resolve(fileDir, account.out),
      })),
      faults: entry.faults ?? [],
    })),
  };

  checkDomains(config, errors);
  if (errors.length > 0) throw new ConfigError(errors);
  return config;
}

/** Expand the scope set words `read` and `read-write`. A list stands as given. */
export function scopesFor(scopes: ServiceAccountEntry['scopes']): string[] {
  if (scopes === 'read') return [...READ_SCOPES];
  if (scopes === 'read-write') return [...READ_WRITE_SCOPES];
  return [...scopes];
}
