import { randomBytes } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Write a file in one step: write a new temporary file beside it, then rename it over the
 * target, so a reader never sees a torn file. With `mode`, the temporary file has exactly that
 * mode before the rename. The temporary file is removed when the write or the rename throws.
 */
export function writeAtomically(
  path: string,
  text: string,
  mode?: number,
): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    // `wx` creates a new file, so `mode` applies from the first byte.
    writeFileSync(temporary, text, { flag: 'wx', mode: mode ?? 0o666 });
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Write a secret, such as a service-account key file, with mode 0600 and no window of a wider mode. */
export function writeSecret(path: string, text: string): void {
  writeAtomically(path, text, 0o600);
}
