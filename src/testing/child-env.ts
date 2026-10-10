import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The variables that steer the mock or its CLI: MOCK_* and ADMIN_SDK_MOCK_*. */
const STEERING = /^(MOCK_|ADMIN_SDK_MOCK_)/;

export interface IsolatedChild {
  /** process.env without any MOCK_* or ADMIN_SDK_MOCK_* variable. */
  readonly env: NodeJS.ProcessEnv;
  /** A new empty directory, so the child finds no ./admin-sdk-mock.json. */
  readonly cwd: string;
  /** Delete the directory. */
  remove(): void;
}

/** process.env without the variables that steer the mock, so a developer's shell cannot change a child. */
export function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !STEERING.test(name)),
  );
}

/**
 * The environment and working directory for a child process that runs the mock. A test adds
 * the MOCK_* variables that it means to set, and calls remove() when it finishes.
 */
export function isolatedChild(prefix = 'child-'): IsolatedChild {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  return {
    env: childEnv(),
    cwd,
    remove: () => rmSync(cwd, { recursive: true, force: true }),
  };
}
