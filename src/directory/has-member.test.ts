import assert from 'node:assert/strict';
import test from 'node:test';
import { SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { saveBeforeImage } from '../store/lag.ts';
import { row, rows } from '../store/sqlite.ts';
import { addTestGroup, addTestMember } from '../testing/groups.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

async function setup(t: import('node:test').TestContext) {
  const clock = fakeClock();
  const harness = await startHarness({ clock });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  domain.db.exec(
    'DELETE FROM groups; DELETE FROM group_members; DELETE FROM group_aliases;',
  );
  const P = domain.spec.primaryDomain;
  // A second own domain stands in for a separate student domain.
  domain.db
    .prepare(
      "INSERT INTO domains (domain_name, is_primary, verified, creation_time, alias_of) VALUES ('second.test', 0, 1, 0, NULL)",
    )
    .run();
  domain.db
    .prepare(
      "INSERT INTO users (id, primary_email, given_name, family_name, full_name, org_unit_path, is_admin, suspended, role, creation_time, ord) VALUES ('199999999999999999999', 'kid@second.test', 'Kid', 'Other', 'Kid Other', '/', 0, 0, 'student', 0, 999999)",
    )
    .run();
  const staff = rows<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        'SELECT id, primary_email FROM users WHERE is_admin = 0 AND primary_email LIKE ? ORDER BY ord LIMIT 4',
      )
      .all(`%@${P}`),
  );
  const kid = { id: '199999999999999999999', primary_email: 'kid@second.test' };
  const top = addTestGroup(domain.db, { email: `top@${P}` });
  const mid = addTestGroup(domain.db, { email: `mid@${P}` });
  const leaf = addTestGroup(domain.db, { email: `leaf@${P}` });
  const link = (
    parent: { id: string },
    child: { id: string; email: string },
    addedAt = 0,
  ) =>
    addTestMember(domain.db, {
      groupId: parent.id,
      memberId: child.id,
      email: child.email,
      type: 'GROUP',
      addedAt,
    });
  const member = (
    group: { id: string },
    user: { id: string; primary_email: string },
  ) =>
    addTestMember(domain.db, {
      groupId: group.id,
      memberId: user.id,
      email: user.primary_email,
    });
  link(top, mid);
  link(mid, leaf);
  member(top, staff[1]);
  member(leaf, staff[0]);
  member(leaf, kid);
  const api = directoryClient(
    harness,
    grantToken(harness, domain, [SCOPES.member[3]]),
  );
  const check = async (group: string, key: string) => {
    const response = await api(
      'GET',
      `/groups/${group}/hasMember/${encodeURIComponent(key)}`,
    );
    return {
      status: response.status,
      body: response.status === 200 ? response.json() : response.json().error,
    };
  };
  return {
    clock,
    harness,
    domain,
    P,
    staff,
    kid,
    top,
    mid,
    leaf,
    link,
    member,
    check,
  };
}

test('hasMember answers direct and nested memberships of users', async (t) => {
  const { staff, top, leaf, check } = await setup(t);
  assert.deepEqual(await check(top.email, staff[1].primary_email), {
    status: 200,
    body: { isMember: true },
  });
  assert.deepEqual(await check(top.email, staff[0].id), {
    status: 200,
    body: { isMember: true },
  });
  assert.deepEqual(await check(top.email, staff[2].primary_email), {
    status: 200,
    body: { isMember: false },
  });
  assert.deepEqual(await check(leaf.email, staff[1].primary_email), {
    status: 200,
    body: { isMember: false },
  });
});

test('a nested check across domains answers 400, and a direct one answers true', async (t) => {
  const { kid, top, leaf, check } = await setup(t);
  assert.deepEqual(await check(leaf.email, kid.primary_email), {
    status: 200,
    body: { isMember: true },
  });
  const nested = await check(top.email, kid.primary_email);
  assert.equal(nested.status, 400);
  assert.equal(nested.body.message, 'Invalid Input');
  assert.equal((await check(top.id, 'kid@second.test')).status, 400);
});

test('only users can be checked', async (t) => {
  const { domain, P, mid, top, check } = await setup(t);
  for (const key of [mid.email, 'parent@home.test', domain.customerId]) {
    const response = await check(top.email, key);
    assert.equal(response.status, 400, key);
    assert.equal(response.body.message, 'Invalid Input: memberKey');
  }
  assert.equal((await check(top.email, `nobody@${P}`)).status, 404);
  assert.equal((await check(`nobody@${P}`, mid.email)).status, 404);
});

test('a customer member contains every user of the same domain', async (t) => {
  const { domain, P, staff, kid, check } = await setup(t);
  const everyone = addTestGroup(domain.db, { email: `everyone@${P}` });
  addTestMember(domain.db, {
    groupId: everyone.id,
    memberId: domain.customerId,
    email: '',
    type: 'CUSTOMER',
  });
  assert.deepEqual(await check(everyone.email, staff[3].primary_email), {
    status: 200,
    body: { isMember: true },
  });
  assert.equal((await check(everyone.email, kid.primary_email)).status, 400);
});

test('nested answers wait for the nesting delay, and direct answers ignore the search delay', async (t) => {
  const { clock, harness, domain, P, staff, top, leaf, link, check } =
    await setup(t);
  const late = addTestGroup(domain.db, { email: `late@${P}` });
  link(leaf, late, harness.mock.clock.now());
  addTestMember(domain.db, {
    groupId: late.id,
    memberId: staff[3].id,
    email: staff[3].primary_email,
  });
  assert.deepEqual((await check(top.email, staff[3].id)).body, {
    isMember: false,
  });
  await clock.advance(600_000);
  assert.deepEqual((await check(top.email, staff[3].id)).body, {
    isMember: true,
  });
  const id = Number(
    row<{ n: number }>(
      domain.db.prepare('SELECT MAX(id) + 1 AS n FROM group_members').get(),
    )!.n,
  );
  saveBeforeImage(
    domain.db,
    'group_members',
    id,
    harness.mock.clock.now(),
    300_000,
  );
  domain.db
    .prepare(
      "INSERT INTO group_members (id, group_id, member_id, email, type, role, delivery, added_at) VALUES (?, ?, ?, ?, 'USER', 'MEMBER', 'ALL_MAIL', ?)",
    )
    .run(
      id,
      leaf.id,
      staff[2].id,
      staff[2].primary_email,
      harness.mock.clock.now(),
    );
  assert.deepEqual((await check(leaf.email, staff[2].id)).body, {
    isMember: true,
  });
});

test('a chain of 10 groups answers from the top', async (t) => {
  const { domain, P, staff, link, member, check } = await setup(t);
  const chain = Array.from({ length: 10 }, (_, n) =>
    addTestGroup(domain.db, { email: `chain-${n}@${P}` }),
  );
  for (let n = 0; n < 9; n++) link(chain[n], chain[n + 1]);
  member(chain[9], staff[2]);
  assert.deepEqual((await check(chain[0].email, staff[2].primary_email)).body, {
    isMember: true,
  });
});

test('a hidden group answers 404', async (t) => {
  const { harness, domain, staff, top, check } = await setup(t);
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: top.id,
  });
  assert.equal((await check(top.email, staff[1].primary_email)).status, 404);
});

test('a nested check skips a middle group hidden by ID', async (t) => {
  const { harness, domain, staff, top, mid, check } = await setup(t);
  assert.deepEqual((await check(top.email, staff[0].id)).body, {
    isMember: true,
  });
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: mid.id,
  });
  assert.deepEqual(await check(top.email, staff[0].id), {
    status: 200,
    body: { isMember: false },
  });
});

test('a removed group link ends nested answers at once', async (t) => {
  const { harness, domain, P, staff, top, link, member, check } =
    await setup(t);
  const side = addTestGroup(domain.db, { email: `side@${P}` });
  const linkId = link(top, side);
  member(side, staff[3]);
  assert.deepEqual((await check(top.email, staff[3].id)).body, {
    isMember: true,
  });
  // Remove the link as members.delete does: save a before-image at now, then delete the row.
  saveBeforeImage(
    domain.db,
    'group_members',
    linkId,
    harness.mock.clock.now(),
    300_000,
  );
  domain.db.prepare('DELETE FROM group_members WHERE id = ?').run(linkId);
  assert.deepEqual((await check(top.email, staff[3].id)).body, {
    isMember: false,
  });
});
