import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ConfigError,
  loadConfigFile,
  resolveConfig,
  type ConfigFlags,
} from '../config/config.ts';
import { FixtureError, loadFixtures } from '../seed/fixtures.ts';
import { SpecError } from '../seed/spec.ts';
import { loadStartupConfig, startServer } from '../server.ts';
import { runControlCommand, UsageError } from './control-commands.ts';
import { runDoctor } from './doctor.ts';
import { runEnv } from './env.ts';
import { HELP, usage, usageFailure } from './help.ts';
import { runInit } from './init.ts';

export interface CliOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  program?: 'admin-sdk-mock' | 'mockctl';
}

/** The resolved output streams and context that every command receives. */
export type Io = Required<CliOptions>;

const HELP_FLAGS = ['--help', '-h'];

/** A port flag as a number. Anything but digits becomes NaN, which resolveConfig reports. */
const portFlag = (text: string | undefined) =>
  text === undefined ? undefined : /^\d+$/.test(text) ? Number(text) : NaN;

/**
 * Catch the first SIGTERM or SIGINT from now on. `received` resolves on that signal.
 * The listeners then come off, so a second signal ends the process at once.
 */
function watchSignals(): {
  received: Promise<NodeJS.Signals>;
  stop: () => void;
} {
  let done: (signal: NodeJS.Signals) => void = () => undefined;
  const received = new Promise<NodeJS.Signals>((resolve) => (done = resolve));
  const stop = () => {
    process.off('SIGTERM', handle);
    process.off('SIGINT', handle);
  };
  const handle = (signal: NodeJS.Signals) => {
    stop();
    done(signal);
  };
  process.on('SIGTERM', handle);
  process.on('SIGINT', handle);
  return { received, stop };
}

/** Start the mock from the configuration and the flags, and run until a signal. */
async function runStart(args: string[], io: Io): Promise<number> {
  // Catch a signal that lands during startup, and act on it once startup settles.
  const signals = watchSignals();
  try {
    return await startUntilSignal(args, io, signals.received);
  } finally {
    signals.stop();
  }
}

/** Parse the flags, start the server, and close it once `signal` resolves. */
async function startUntilSignal(
  args: string[],
  io: Io,
  signal: Promise<NodeJS.Signals>,
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      'data-dir': { type: 'string' },
      'google-host': { type: 'string' },
      'google-port': { type: 'string' },
      'control-host': { type: 'string' },
      'control-port': { type: 'string' },
      'proxy-host': { type: 'string' },
      'proxy-port': { type: 'string' },
      passthrough: { type: 'boolean' },
      scale: { type: 'string' },
      delays: { type: 'string' },
      'ca-file': { type: 'string' },
      'ready-file': { type: 'string' },
    },
  });
  const { delays, scale } = values;
  if (delays !== undefined && delays !== 'on' && delays !== 'off') {
    io.stderr('--delays must be on or off.\n');
    return 2;
  }
  const flags: ConfigFlags = {
    dataDir: values['data-dir'],
    googleHost: values['google-host'],
    googlePort: portFlag(values['google-port']),
    controlHost: values['control-host'],
    controlPort: portFlag(values['control-port']),
    proxyHost: values['proxy-host'],
    proxyPort: portFlag(values['proxy-port']),
    passthrough: values.passthrough,
    scale: scale === undefined ? undefined : Number(scale),
    delays: delays === undefined ? undefined : delays === 'on',
    caFile: values['ca-file'],
    readyFile: values['ready-file'],
  };
  const config = loadStartupConfig({
    flags,
    configFlag: values.config,
    env: io.env,
    cwd: io.cwd,
  });
  const server = await startServer(config, {
    log: (event) => io.stdout(`${JSON.stringify(event)}\n`),
  });
  await signal;
  await server.close();
  return 0;
}

/** `config validate <file>`: validate the file and its fixtures files, and print every error. */
function runConfig(args: string[], io: Io): number {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const [sub, name, extra] = positionals;
  if (sub !== 'validate')
    return usageFailure(
      io,
      'config',
      sub === undefined ? undefined : `Unknown config command: ${sub}.`,
    );
  if (name === undefined || extra !== undefined)
    return usageFailure(io, 'config', 'config validate takes one file.');
  const file = resolve(io.cwd, name);
  const config = resolveConfig({
    file: loadConfigFile(file),
    fileDir: dirname(file),
    env: {},
    cwd: io.cwd,
  });
  const errors: string[] = [];
  for (const entry of config.domains) {
    if (entry.fixtures === null) continue;
    try {
      loadFixtures(entry.fixtures);
    } catch (error) {
      if (!(error instanceof FixtureError)) throw error;
      errors.push(...error.errors);
    }
  }
  if (errors.length > 0) throw new FixtureError(errors);
  io.stdout(`${name} is valid.\n`);
  return 0;
}

/** A parseArgs failure: an unknown option, a missing value, or an unexpected argument. */
const isParseError = (error: unknown): error is Error =>
  error instanceof TypeError &&
  String((error as NodeJS.ErrnoException).code).startsWith('ERR_PARSE_ARGS_');

/**
 * Run one command of the CLI and return its exit code: 0 for success, 1 for a runtime
 * failure, and 2 for invalid usage or configuration. `start` resolves after a signal.
 */
export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<number> {
  const io: Io = {
    stdout: options.stdout ?? ((text) => void process.stdout.write(text)),
    stderr: options.stderr ?? ((text) => void process.stderr.write(text)),
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    program: options.program ?? 'admin-sdk-mock',
  };
  const [command, ...rest] = argv;
  if (command === undefined) return usageFailure(io, '');
  const known = (name: string | undefined): name is string =>
    name !== undefined && name !== '' && Object.hasOwn(HELP, name);
  if (command === 'help' || HELP_FLAGS.includes(command)) {
    const topic = command === 'help' ? rest[0] : undefined;
    if (topic !== undefined && !known(topic))
      return usageFailure(io, '', `Unknown command: ${topic}.`);
    io.stdout(`${usage(topic ?? '', io.program)}\n`);
    return 0;
  }
  if (!known(command))
    return usageFailure(io, '', `Unknown command: ${command}.`);
  if (rest.some((arg) => HELP_FLAGS.includes(arg))) {
    io.stdout(`${usage(command, io.program)}\n`);
    return 0;
  }

  try {
    switch (command) {
      case 'start':
        return await runStart(rest, io);
      case 'init':
        return runInit(rest, io);
      case 'env':
        return await runEnv(rest, io);
      case 'doctor':
        return await runDoctor(rest, io);
      case 'config':
        return runConfig(rest, io);
      default:
        return await runControlCommand(argv, io);
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof FixtureError) {
      for (const line of error.errors) io.stderr(`${line}\n`);
      return 2;
    }
    if (error instanceof SpecError || error instanceof UsageError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    if (isParseError(error)) {
      io.stderr(
        `${error.message}\nRun ${io.program} ${command} --help for its usage.\n`,
      );
      return 2;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
