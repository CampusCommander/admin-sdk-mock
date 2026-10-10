import assert from 'node:assert/strict';
import test from 'node:test';
import { openDomainDb } from '../store/domain-db.ts';
import { addTestGroup, addTestMember } from '../testing/groups.ts';
import { reachedGroups, reaches } from './group-graph.ts';

function chain() {
  const db = openDomainDb(':memory:');
  const groups = ['a', 'b', 'c', 'd'].map((name) =>
    addTestGroup(db, { email: `${name}@lake.test`, id: `0${name.repeat(14)}` }),
  );
  // a contains b, b contains c (added late), c contains d.
  const link = (parent: number, child: number, addedAt = 0) =>
    addTestMember(db, {
      groupId: groups[parent].id,
      memberId: groups[child].id,
      email: groups[child].email,
      type: 'GROUP',
      addedAt,
    });
  link(0, 1);
  link(1, 2, 5_000);
  link(2, 3);
  addTestMember(db, {
    groupId: groups[3].id,
    memberId: 'u1',
    email: 'u1@lake.test',
  });
  return { db, ids: groups.map((group) => group.id) };
}

test('reachedGroups follows only links added by followableAt', () => {
  const { db, ids } = chain();
  assert.deepEqual(
    reachedGroups(db, 'group_members', ids[0], 4_999).sort(),
    [ids[0], ids[1]].sort(),
  );
  assert.deepEqual(
    reachedGroups(db, 'group_members', ids[0], 5_000).sort(),
    [...ids].sort(),
  );
  assert.deepEqual(reachedGroups(db, 'group_members', ids[3], 10_000), [
    ids[3],
  ]);
});

test('reaches follows every link, including links inside the nesting delay', () => {
  const { db, ids } = chain();
  assert.equal(reaches(db, ids[0], ids[3]), true);
  assert.equal(reaches(db, ids[1], ids[1]), true);
  assert.equal(reaches(db, ids[3], ids[0]), false);
});

test('reachedGroups stops at an excluded group by ID or email', () => {
  const { db, ids } = chain();
  assert.deepEqual(
    reachedGroups(db, 'group_members', ids[0], 10_000, [ids[2]]).sort(),
    [ids[0], ids[1]].sort(),
  );
  assert.deepEqual(
    reachedGroups(db, 'group_members', ids[0], 10_000, ['b@lake.test']),
    [ids[0]],
  );
});
