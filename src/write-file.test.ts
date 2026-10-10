import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { writeAtomically, writeSecret } from './write-file.ts';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'write-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('writeSecret replaces a file in one rename with mode 0600 and leaves no temporary file', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'key.json');
  writeFileSync(path, 'old');
  chmodSync(path, 0o644);
  const before = statSync(path);
  writeSecret(path, 'new');
  const after = statSync(path);
  assert.equal(readFileSync(path, 'utf8'), 'new');
  assert.equal(after.mode & 0o777, 0o600);
  assert.notEqual(after.ino, before.ino);
  assert.deepEqual(readdirSync(dir), ['key.json']);
  writeSecret(join(dir, 'fresh.json'), 'x');
  assert.equal(statSync(join(dir, 'fresh.json')).mode & 0o777, 0o600);
});

test('writeAtomically removes its temporary file when the rename fails', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'taken');
  mkdirSync(join(path, 'inside'), { recursive: true });
  assert.throws(() => writeAtomically(path, 'text'));
  assert.deepEqual(readdirSync(dir), ['taken']);
  assert.throws(() => writeSecret(path, 'text'));
  assert.deepEqual(readdirSync(dir), ['taken']);
});
