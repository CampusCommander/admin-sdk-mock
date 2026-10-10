import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveSpec } from '../seed/spec.ts';
import type { Io } from './main.ts';

const DEFAULT_OUT = 'admin-sdk-mock.json';
const KEY_FILE = './.admin-sdk-mock/credentials/demo.json';
const DEMO_SPEC = { tier: 'small', seed: 'demo' } as const;

/** The starter configuration: one small domain, a proxy, and a read-write service account. */
export const STARTER_CONFIG = `{
  "$schema": "./node_modules/@campuscommander/admin-sdk-mock/schema/config.schema.json",
  "dataDir": "./.admin-sdk-mock/data",
  "listen": { "proxy": { "port": 3128 } },
  "domains": [
    {
      "spec": { "tier": "${DEMO_SPEC.tier}", "seed": "${DEMO_SPEC.seed}" },
      "serviceAccounts": [
        { "out": "${KEY_FILE}", "scopes": "read-write" }
      ]
    }
  ]
}
`;

/** Quote a path for a POSIX shell when it holds more than safe characters. */
const shellWord = (text: string) =>
  /^[\w./@%+=:,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

/** Write the starter configuration and print the next steps. */
export function runInit(args: string[], io: Io): number {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
  });
  const out = values.out ?? DEFAULT_OUT;
  const path = resolve(io.cwd, out);
  mkdirSync(dirname(path), { recursive: true });
  try {
    // Without --force, `wx` refuses an existing file in the same step that creates it.
    writeFileSync(path, STARTER_CONFIG, { flag: values.force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    io.stderr(`${out} already exists. Pass --force to replace it.\n`);
    return 2;
  }

  const config =
    path === join(io.cwd, DEFAULT_OUT) ? '' : ` --config ${shellWord(out)}`;
  const keyFile = relative(io.cwd, resolve(dirname(path), KEY_FILE));
  const subject = `admin@${resolveSpec(DEMO_SPEC).primaryDomain}`;
  io.stdout(`Wrote ${out}.

Next steps:
  1. Start the mock:
       npx admin-sdk-mock start${config}
  2. Load the client environment in the shell of the client under test:
       eval "$(npx admin-sdk-mock env${config})"
  3. Use the key file ${keyFile} with the subject ${subject}.

Add .admin-sdk-mock/ to .gitignore.
`);
  return 0;
}
