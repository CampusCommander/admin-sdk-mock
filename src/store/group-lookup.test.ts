import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRandom } from '../random.ts';
import { addTestGroup } from '../testing/groups.ts';
import { openDomainDb } from './domain-db.ts';
import { findGroup, newGroupId, outsideMemberId } from './group-lookup.ts';

function openTemp(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'group-lookup-'));
  const db = openDomainDb(join(dir, 'domain.sqlite'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('findGroup matches the email without case, an alias, and the ID', (t) => {
  const db = openTemp(t);
  const group = addTestGroup(db, { email: 'staff@lake.test' });
  db.prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)').run(
    'teachers@lake.test',
    group.id,
  );
  assert.equal(findGroup(db, 'STAFF@Lake.test')?.id, group.id);
  assert.equal(findGroup(db, 'Teachers@lake.test')?.id, group.id);
  assert.equal(findGroup(db, group.id)?.email, 'staff@lake.test');
  assert.equal(findGroup(db, 'nobody@lake.test'), undefined);
});

test('outside member IDs are stable 21-digit numbers', () => {
  const id = outsideMemberId('Parent.One@Home.test');
  assert.match(id, /^1\d{20}$/);
  assert.equal(id, outsideMemberId('parent.one@home.test'));
  assert.notEqual(id, outsideMemberId('parent.two@home.test'));
});

test('group IDs are 15 characters and skip taken IDs', () => {
  const first = newGroupId(createRandom('ids'), () => false);
  assert.match(first, /^0[0-9a-z]{14}$/);
  const second = newGroupId(createRandom('ids'), (id) => id === first);
  assert.notEqual(second, first);
  assert.match(second, /^0[0-9a-z]{14}$/);
});
