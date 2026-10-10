import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  clientEnvironment,
  loadStartupConfig,
  urlHost,
  type ServerInfo,
} from '../server.ts';
import { controlUrl, noMockMessage } from './control-commands.ts';
import type { Io } from './main.ts';

export type EnvironmentFormat = 'sh' | 'dotenv' | 'json' | 'github';

const FORMATS: readonly string[] = ['sh', 'dotenv', 'json', 'github'];

/** A dotenv value, double-quoted when it holds whitespace, a quote, `#`, or `$`. */
function dotenvValue(value: string): string {
  if (!/[\s"'#$]/.test(value)) return value;
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
  return `"${escaped}"`;
}

/** Render environment variables for a shell, a dotenv file, JSON, or $GITHUB_ENV. */
export function formatEnvironment(
  vars: Record<string, string>,
  format: EnvironmentFormat,
): string {
  const entries = Object.entries(vars);
  const lines = (render: (name: string, value: string) => string) =>
    entries.map(([name, value]) => `${render(name, value)}\n`).join('');
  switch (format) {
    case 'sh':
      return lines(
        (name, value) => `export ${name}='${value.replaceAll("'", "'\\''")}'`,
      );
    case 'dotenv':
      return lines((name, value) => `${name}=${dotenvValue(value)}`);
    case 'json':
      return `${JSON.stringify(vars, null, 2)}\n`;
    case 'github':
      return lines((name, value) => {
        if (/[\r\n]/.test(value))
          throw new Error(
            `GITHUB_ENV cannot hold a value with a newline: ${name}.`,
          );
        return `${name}=${value}`;
      });
  }
}

/**
 * The control URL: --control, MOCK_CONTROL_URL, ADMIN_SDK_MOCK_CONTROL, then the control
 * listener of the startup configuration, which defaults to 127.0.0.1:8080.
 */
const envControlUrl = (
  values: { control?: string; config?: string },
  io: Io,
): string =>
  controlUrl(values.control, io, () => {
    const { host, port } = loadStartupConfig({
      configFlag: values.config,
      env: io.env,
      cwd: io.cwd,
    }).listen.control;
    return `http://${urlHost(host)}:${port}`;
  });

/** Print the client environment of a running mock, or append it to $GITHUB_ENV. */
export async function runEnv(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      format: { type: 'string' },
      control: { type: 'string' },
      config: { type: 'string' },
    },
  });
  const format = values.format ?? 'sh';
  if (!FORMATS.includes(format)) {
    io.stderr('--format must be sh, dotenv, json, or github.\n');
    return 2;
  }
  const githubEnv = io.env.GITHUB_ENV;
  if (format === 'github' && !githubEnv) {
    io.stderr('GITHUB_ENV is not set.\n');
    return 2;
  }
  const url = envControlUrl(values, io);
  let info: ServerInfo;
  try {
    const response = await fetch(`${url}/info`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    info = (await response.json()) as ServerInfo;
    if (!info?.listeners) throw new Error('the answer names no listeners');
  } catch (error) {
    io.stderr(`${noMockMessage(url, error)}\n`);
    return 1;
  }
  if (!info.listeners.proxy)
    io.stderr(
      'The proxy is off. Set listen.proxy in the configuration to route clients through it.\n',
    );
  const text = formatEnvironment(
    clientEnvironment(info, url),
    format as EnvironmentFormat,
  );
  if (githubEnv && format === 'github')
    appendFileSync(resolve(io.cwd, githubEnv), text);
  else io.stdout(text);
  return 0;
}
