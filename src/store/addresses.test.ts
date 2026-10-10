import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addTestGroup } from '../testing/groups.ts';
import { addressInUse, domainKind } from './addresses.ts';
import { openDomainDb } from './domain-db.ts';

test('addressInUse covers users, user aliases, groups, and group aliases', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'addresses-'));
  const db = openDomainDb(join(dir, 'domain.sqlite'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.prepare(
    "INSERT INTO users (id, primary_email, given_name, family_name, full_name, org_unit_path, is_admin, suspended, role, creation_time, ord) VALUES ('u1', 'ann@lake.test', 'Ann', 'Lee', 'Ann Lee', '/', 0, 0, 'staff', 0, 0)",
  ).run();
  db.prepare(
    "INSERT INTO user_aliases (alias, user_id) VALUES ('a.lee@lake.test', 'u1')",
  ).run();
  const group = addTestGroup(db, { email: 'staff@lake.test' });
  db.prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)').run(
    'faculty@lake.test',
    group.id,
  );
  for (const email of [
    'ann@lake.test',
    'a.lee@lake.test',
    'staff@lake.test',
    'faculty@lake.test',
  ])
    assert.equal(addressInUse(db, email), true, email);
  assert.equal(addressInUse(db, 'free@lake.test'), false);
  assert.equal(addressInUse(db, 'ann@lake.test', { userId: 'u1' }), false);
  assert.equal(addressInUse(db, 'a.lee@lake.test', { userId: 'u1' }), false);
  assert.equal(
    addressInUse(db, 'faculty@lake.test', { groupId: group.id }),
    false,
  );
  assert.equal(addressInUse(db, 'staff@lake.test', { userId: 'u1' }), true);
});

test('domainKind tells own domains, alias domains, and outside domains apart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'addresses-'));
  const db = openDomainDb(join(dir, 'domain.sqlite'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const domain = db.prepare(
    'INSERT INTO domains (domain_name, is_primary, verified, creation_time, alias_of) VALUES (?, ?, 1, 0, ?)',
  );
  domain.run('lake.test', 1, null);
  domain.run('lake-k12.test', 0, 'lake.test');
  assert.equal(domainKind(db, 'x@lake.test'), 'own');
  assert.equal(domainKind(db, 'x@LAKE-K12.test'), 'alias');
  assert.equal(domainKind(db, 'x@home.test'), 'outside');
});
