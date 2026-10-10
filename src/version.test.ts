import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { packageRoot, VERSION } from './version.ts';

test('packageRoot finds this package and VERSION matches its package.json', () => {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot(), 'package.json'), 'utf8'),
  ) as {
    name: string;
    version: string;
  };
  assert.equal(manifest.name, '@campuscommander/admin-sdk-mock');
  assert.equal(VERSION, manifest.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
