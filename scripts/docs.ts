// Rewrite the generated sections of docs/reference/ from the schema, the CLI help, and the
// route table, then format the pages with Prettier.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatedSections, replaceGenerated } from '../src/docs/generate.ts';
import { packageRoot } from '../src/version.ts';

const root = packageRoot();
const pages = generatedSections().map(({ file, name, content }) => {
  const path = join(root, file);
  writeFileSync(
    path,
    replaceGenerated(readFileSync(path, 'utf8'), name, content),
  );
  return path;
});
execFileSync(
  join(root, 'node_modules', '.bin', 'prettier'),
  ['--write', ...pages],
  {
    stdio: 'inherit',
  },
);
