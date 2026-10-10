import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = '@campuscommander/admin-sdk-mock';

/**
 * The directory that holds this package's package.json. It works from `src/`
 * in development and from `dist/src/` in an installed package.
 */
export function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
      };
      if (manifest.name === NAME) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot find the ${NAME} package.json.`);
    directory = parent;
  }
}

export const VERSION: string = (
  JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
