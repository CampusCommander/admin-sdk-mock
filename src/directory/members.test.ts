import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES, SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { outsideMemberId } from '../store/group-lookup.ts';
import { saveBeforeImage } from '../store/lag.ts';
import { row, rows } from '../store/sqlite.ts';
import { addTestGroup, addTestMember } from '../testing/groups.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { derivedQuery } from './members.ts';

const D = 300_000;
const NEST = 600_000;

async function setup(t: import('node:test').TestContext) {
  const clock = fakeClock();
  const harness = await startHarness({ clock });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  domain.db.exec(
    'DELETE FROM groups; DELETE FROM group_members; DELETE FROM group_aliases;',
  );
  const P = domain.spec.primaryDomain;
  const users = rows<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        'SELECT id, primary_email FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 4',
      )
      .all(),
  );
  const [u1, u2, u3, u4] = users;
  domain.db.prepare('UPDATE users SET suspended = 1 WHERE id = ?').run(u3.id);
  const top = addTestGroup(domain.db, { email: `top@${P}` });
  const mid = addTestGroup(domain.db, { email: `mid@${P}` });
  const leaf = addTestGroup(domain.db, { email: `leaf@${P}` });
  const parent = 'parent.one@home.test';
  const add = (
    group: { id: string },
    member: { id: string; email: string },
    extra: {
      type?: 'USER' | 'GROUP' | 'CUSTOMER';
      role?: 'OWNER' | 'MANAGER' | 'MEMBER';
    } = {},
  ) =>
    addTestMember(domain.db, {
      groupId: group.id,
      memberId: member.id,
      email: member.email,
      ...extra,
    });
  const asUser = (user: { id: string; primary_email: string }) => ({
    id: user.id,
    email: user.primary_email,
  });
  add(top, asUser(u1), { role: 'OWNER' });
  add(top, mid, { type: 'GROUP' });
  add(top, { id: domain.customerId, email: '' }, { type: 'CUSTOMER' });
  add(mid, asUser(u2), { role: 'MANAGER' });
  add(mid, leaf, { type: 'GROUP' });
  add(mid, { id: outsideMemberId(parent), email: parent });
  add(leaf, asUser(u3));
  add(leaf, asUser(u1));
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_SCOPES),
  );
  const list = async (
    key: string,
    query: Record<string, string | number> = {},
  ) => {
    const response = await api('GET', `/groups/${key}/members`, { query });
    assert.equal(response.status, 200, response.text);
    return response.json();
  };
  const ids = async (
    key: string,
    query: Record<string, string | number> = {},
  ) =>
    ((await list(key, query)).members ?? []).map(
      (member: { id: string }) => member.id,
    );
  /** Follow every page and return the member IDs in order. */
  const allIds = async (
    key: string,
    query: Record<string, string | number>,
  ) => {
    const out: string[] = [];
    let pageToken: string | undefined;
    do {
      const body = await list(key, {
        ...query,
        ...(pageToken ? { pageToken } : {}),
      });
      out.push(
        ...(body.members ?? []).map((member: { id: string }) => member.id),
      );
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  };
  const byEmail = (entries: { id: string; email: string }[]) =>
    [...entries]
      .sort((a, b) =>
        a.email < b.email ? -1 : a.email > b.email ? 1 : a.id < b.id ? -1 : 1,
      )
      .map((e) => e.id);
  return {
    clock,
    harness,
    domain,
    P,
    api,
    list,
    ids,
    allIds,
    byEmail,
    top,
    mid,
    leaf,
    u1,
    u2,
    u3,
    u4,
    parent,
    asUser,
  };
}

test('members.list returns direct members in email order without delivery settings', async (t) => {
  const { domain, list, top, mid, u1, byEmail, asUser } = await setup(t);
  const body = await list(top.email);
  assert.equal(body.kind, 'admin#directory#members');
  assert.deepEqual(
    body.members.map((member: { id: string }) => member.id),
    [domain.customerId, ...byEmail([asUser(u1), mid])],
  );
  const customer = { ...body.members[0] };
  delete customer.etag;
  assert.deepEqual(customer, {
    kind: 'admin#directory#member',
    id: domain.customerId,
    role: 'MEMBER',
    type: 'CUSTOMER',
    status: 'ACTIVE',
  });
  for (const member of body.members)
    assert.equal(member.delivery_settings, undefined);
  assert.equal(
    body.members.find((m: { id: string }) => m.id === u1.id).role,
    'OWNER',
  );
});

test('roles filters by role and rejects unknown roles', async (t) => {
  const { api, ids, top, mid, u1, u2 } = await setup(t);
  assert.deepEqual(await ids(top.email, { roles: 'OWNER' }), [u1.id]);
  assert.deepEqual(await ids(mid.email, { roles: 'OWNER,MANAGER' }), [u2.id]);
  assert.equal(
    (
      await api('GET', `/groups/${top.email}/members`, {
        query: { roles: 'BOSS' },
      })
    ).status,
    400,
  );
});

test('includeDerivedMembership lists each reached member once with its highest role', async (t) => {
  const {
    domain,
    list,
    allIds,
    byEmail,
    top,
    mid,
    leaf,
    u1,
    u2,
    u3,
    parent,
    asUser,
  } = await setup(t);
  const expected = [
    domain.customerId,
    ...byEmail([
      asUser(u1),
      asUser(u2),
      asUser(u3),
      mid,
      leaf,
      { id: outsideMemberId(parent), email: parent },
    ]),
  ];
  assert.deepEqual(
    await allIds(top.email, { includeDerivedMembership: 'true' }),
    expected,
  );
  // u1 sits in top and in leaf. Small pages must neither repeat nor skip it.
  assert.deepEqual(
    await allIds(top.email, {
      includeDerivedMembership: 'true',
      maxResults: 2,
    }),
    expected,
  );
  const derived = (await list(top.email, { includeDerivedMembership: 'true' }))
    .members;
  assert.equal(
    derived.find((m: { id: string }) => m.id === u1.id).role,
    'OWNER',
  );
  assert.equal(
    derived.find((m: { id: string }) => m.id === u3.id).status,
    'SUSPENDED',
  );
  assert.equal(
    derived.find((m: { id: string }) => m.id === u2.id).role,
    'MANAGER',
  );
  const members = await allIds(top.email, {
    includeDerivedMembership: 'true',
    roles: 'MEMBER',
  });
  assert.ok(
    !members.includes(u1.id) &&
      !members.includes(u2.id) &&
      members.includes(u3.id),
  );
});

test('a new group link waits for the nesting delay before derived lists follow it', async (t) => {
  const { clock, harness, domain, P, allIds, leaf, top, u4, asUser } =
    await setup(t);
  const late = addTestGroup(domain.db, { email: `late@${P}` });
  addTestMember(domain.db, {
    groupId: leaf.id,
    memberId: late.id,
    email: late.email,
    type: 'GROUP',
    addedAt: harness.mock.clock.now(),
  });
  addTestMember(domain.db, {
    groupId: late.id,
    memberId: u4.id,
    email: asUser(u4).email,
  });
  const before = await allIds(top.email, { includeDerivedMembership: 'true' });
  assert.ok(before.includes(late.id));
  assert.ok(!before.includes(u4.id));
  await clock.advance(NEST);
  assert.ok(
    (await allIds(top.email, { includeDerivedMembership: 'true' })).includes(
      u4.id,
    ),
  );
});

test('direct lists lag a new membership while get shows it at once', async (t) => {
  const { clock, harness, domain, api, ids, leaf, u2, asUser } = await setup(t);
  const id = Number(
    row<{ n: number }>(
      domain.db.prepare('SELECT MAX(id) + 1 AS n FROM group_members').get(),
    )!.n,
  );
  saveBeforeImage(domain.db, 'group_members', id, harness.mock.clock.now(), D);
  domain.db
    .prepare(
      "INSERT INTO group_members (id, group_id, member_id, email, type, role, delivery, added_at) VALUES (?, ?, ?, ?, 'USER', 'MEMBER', 'DIGEST', 0)",
    )
    .run(id, leaf.id, u2.id, asUser(u2).email);
  assert.ok(!(await ids(leaf.email)).includes(u2.id));
  const got = await api('GET', `/groups/${leaf.email}/members/${u2.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json().delivery_settings, 'DIGEST');
  await clock.advance(D);
  assert.ok((await ids(leaf.email)).includes(u2.id));
});

test('members.get finds direct members by every key and answers 404 for nested ones', async (t) => {
  const { domain, api, top, mid, leaf, u1, u2, u3, parent, asUser } =
    await setup(t);
  domain.db
    .prepare('INSERT INTO user_aliases (alias, user_id) VALUES (?, ?)')
    .run(`nick.${u1.id.slice(-4)}@${domain.spec.primaryDomain}`, u1.id);
  for (const key of [
    asUser(u1).email,
    u1.id,
    `nick.${u1.id.slice(-4)}@${domain.spec.primaryDomain}`,
  ]) {
    const got = await api(
      'GET',
      `/groups/${top.email}/members/${encodeURIComponent(key)}`,
    );
    assert.equal(got.status, 200, key);
    const body = got.json();
    delete body.etag;
    assert.deepEqual(body, {
      kind: 'admin#directory#member',
      id: u1.id,
      email: asUser(u1).email,
      role: 'OWNER',
      type: 'USER',
      status: 'ACTIVE',
      delivery_settings: 'ALL_MAIL',
    });
  }
  assert.equal(
    (await api('GET', `/groups/${leaf.email}/members/${u3.id}`)).json().status,
    'SUSPENDED',
  );
  assert.equal(
    (await api('GET', `/groups/${top.email}/members/${mid.email}`)).json().type,
    'GROUP',
  );
  assert.equal(
    (
      await api('GET', `/groups/${top.email}/members/${domain.customerId}`)
    ).json().email,
    undefined,
  );
  assert.equal(
    (await api('GET', `/groups/${mid.email}/members/${parent}`)).json().id,
    outsideMemberId(parent),
  );
  assert.equal(
    (
      await api(
        'GET',
        `/groups/${mid.email}/members/${outsideMemberId(parent)}`,
      )
    ).status,
    200,
  );
  const nested = await api('GET', `/groups/${top.email}/members/${u2.id}`);
  assert.equal(nested.status, 404);
  assert.equal(nested.json().error.message, 'Resource Not Found: memberKey');
  assert.equal(
    (await api('GET', `/groups/nobody@x.test/members/${u1.id}`)).status,
    404,
  );
});

test('member reads accept the member scopes and respect remove-entity faults', async (t) => {
  const { harness, domain, ids, top, u1 } = await setup(t);
  const memberReader = directoryClient(
    harness,
    grantToken(harness, domain, [SCOPES.member[3]]),
  );
  assert.equal(
    (await memberReader('GET', `/groups/${top.email}/members`)).status,
    200,
  );
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: u1.id,
  });
  assert.ok(!(await ids(top.email)).includes(u1.id));
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: top.id,
  });
  assert.equal(
    (await memberReader('GET', `/groups/${top.email}/members`)).status,
    404,
  );
  assert.equal(
    (
      await memberReader(
        'GET',
        `/groups/${top.email}/members/${domain.customerId}`,
      )
    ).status,
    404,
  );
});

test('large derived pages scan the email index in order without a sort', async (t) => {
  const { domain, P, allIds, top, leaf } = await setup(t);
  const insert = domain.db.prepare(
    "INSERT INTO group_members (group_id, member_id, email, type, role, delivery, added_at) VALUES (?, ?, ?, 'USER', 'MEMBER', 'ALL_MAIL', 0)",
  );
  domain.db.exec('BEGIN');
  for (let n = 0; n < 5_200; n++)
    insert.run(
      leaf.id,
      `9${String(n).padStart(20, '0')}`,
      `bulk${String(n).padStart(5, '0')}@${P}`,
    );
  domain.db.exec('COMMIT');
  const listed = await allIds(top.email, { includeDerivedMembership: 'true' });
  assert.equal(new Set(listed).size, listed.length);
  assert.ok(listed.length > 5_200);
  const sql = derivedQuery('group_members', 5_208, { cursor: true, roles: 0 });
  assert.match(sql, /INDEXED BY group_members_email/);
  const plan = rows<{ detail: string }>(
    domain.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('[]', '', '', 201),
  ).map((step) => step.detail);
  assert.ok(
    !plan.some((detail) => detail.includes('TEMP B-TREE')),
    plan.join(' | '),
  );
  assert.match(
    derivedQuery('group_members', 10, { cursor: false, roles: 0 }),
    /INDEXED BY group_members_order/,
  );
  assert.doesNotMatch(
    derivedQuery('group_members_listed', 9_999, { cursor: false, roles: 0 }),
    /INDEXED BY/,
  );
});

test('a user hidden by a remove-entity fault answers 404 by ID and by email', async (t) => {
  const { harness, domain, api, top, u1, asUser } = await setup(t);
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: u1.id,
  });
  for (const key of [u1.id, asUser(u1).email]) {
    const got = await api(
      'GET',
      `/groups/${top.email}/members/${encodeURIComponent(key)}`,
    );
    assert.equal(got.status, 404, key);
  }
});

test('a group hidden by its email leaves the direct list of its parent', async (t) => {
  const { harness, domain, ids, top, mid } = await setup(t);
  assert.ok((await ids(top.email)).includes(mid.id));
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: mid.email,
  });
  assert.ok(!(await ids(top.email)).includes(mid.id));
});

test('a nested group hidden by ID removes its members from derived lists', async (t) => {
  const { harness, domain, allIds, top, mid, u2, parent } = await setup(t);
  const before = await allIds(top.email, { includeDerivedMembership: 'true' });
  assert.ok(before.includes(u2.id) && before.includes(outsideMemberId(parent)));
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: mid.id,
  });
  const after = await allIds(top.email, { includeDerivedMembership: 'true' });
  assert.ok(!after.includes(mid.id));
  assert.ok(!after.includes(u2.id) && !after.includes(outsideMemberId(parent)));
});
