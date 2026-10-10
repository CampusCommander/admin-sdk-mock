import assert from 'node:assert/strict';
import test from 'node:test';
import {
  READ_SCOPES,
  READ_WRITE_SCOPES,
  WRITE_SCOPES,
} from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { row, rows } from '../store/sqlite.ts';
import { addTestGroup, addTestMember } from '../testing/groups.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const D = 300_000;

async function setup(t: import('node:test').TestContext) {
  const clock = fakeClock();
  const harness = await startHarness({ clock });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  domain.db.exec(
    'DELETE FROM groups; DELETE FROM group_members; DELETE FROM group_aliases;',
  );
  const P = domain.spec.primaryDomain;
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const user = row<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        'SELECT id, primary_email FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 1',
      )
      .get(),
  )!;
  const listed = async () =>
    (
      (
        await api('GET', '/groups', { query: { customer: 'my_customer' } })
      ).json().groups ?? []
    ).map((group: { email: string }) => group.email);
  return { clock, harness, domain, P, api, user, listed };
}

test('insert creates an admin-created group that get shows at once and lists show after the delay', async (t) => {
  const { clock, api, P, listed } = await setup(t);
  const created = await api('POST', '/groups', {
    body: { email: `New.Team@${P}` },
  });
  assert.equal(created.status, 200, created.text);
  const body = created.json();
  assert.match(body.id, /^0[0-9a-z]{14}$/);
  assert.equal(body.email, `new.team@${P}`);
  assert.equal(body.name, 'new.team');
  assert.equal(body.description, '');
  assert.equal(body.directMembersCount, '0');
  assert.equal(body.adminCreated, true);
  assert.equal((await api('GET', `/groups/${body.id}`)).status, 200);
  assert.deepEqual(await listed(), []);
  await clock.advance(D);
  assert.deepEqual(await listed(), [`new.team@${P}`]);
});

test('insert validates the address, the description, and uniqueness', async (t) => {
  const { harness, domain, api, P, user } = await setup(t);
  const status = async (body: unknown) =>
    (await api('POST', '/groups', { body })).status;
  assert.equal(await status({}), 400);
  assert.equal(await status({ email: 'not-an-address' }), 400);
  assert.equal(await status({ email: 'x@elsewhere.test' }), 400);
  assert.equal(await status({ email: `x@${domain.spec.aliasDomain}` }), 400);
  assert.equal(
    await status({ email: `x@${P}`, description: 'd'.repeat(4097) }),
    400,
  );
  assert.equal(
    await status({ email: `ok@${P}`, description: 'd'.repeat(4096) }),
    200,
  );
  const missing = await api('POST', '/groups', { body: {} });
  assert.equal(missing.json().error.message, 'Invalid Input: email');
  domain.db
    .prepare('INSERT INTO user_aliases (alias, user_id) VALUES (?, ?)')
    .run(`nick@${P}`, user.id);
  const taken = addTestGroup(domain.db, { email: `taken@${P}` });
  domain.db
    .prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)')
    .run(`taken-alias@${P}`, taken.id);
  for (const email of [
    user.primary_email,
    `nick@${P}`,
    `taken@${P}`,
    `taken-alias@${P}`,
  ])
    assert.equal(await status({ email }), 409, email);
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: { searchDelaySeconds: 0 },
  });
  assert.equal(await status({ email: `instant@${P}` }), 200);
  const listed = (
    await api('GET', '/groups', {
      query: { customer: 'my_customer', query: `email=instant@${P}` },
    })
  ).json().groups;
  assert.equal(listed.length, 1);
});

test('patch and update change only the fields present', async (t) => {
  const { domain, api, P } = await setup(t);
  const group = addTestGroup(domain.db, {
    email: `staff@${P}`,
    name: 'Staff',
    description: 'All staff',
  });
  const patched = await api('PATCH', `/groups/${group.email}`, {
    body: { name: 'Faculty' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json().name, 'Faculty');
  assert.equal(patched.json().description, 'All staff');
  const updated = await api('PUT', `/groups/${group.id}`, {
    body: { description: 'Teachers' },
  });
  assert.equal(updated.json().name, 'Faculty');
  assert.equal(updated.json().description, 'Teachers');
  assert.equal(
    (
      await api('PATCH', `/groups/${group.id}`, {
        body: { description: 'd'.repeat(4097) },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api('PATCH', `/groups/${group.id}`, {
        body: { aliases: ['x@y.test'], adminCreated: false },
      })
    ).json().adminCreated,
    true,
  );
});

test('an email change keeps the old address as an alias and updates parent memberships', async (t) => {
  const { clock, domain, api, P } = await setup(t);
  const child = addTestGroup(domain.db, { email: `old@${P}` });
  const parent = addTestGroup(domain.db, { email: `parent@${P}` });
  addTestMember(domain.db, {
    groupId: parent.id,
    memberId: child.id,
    email: child.email,
    type: 'GROUP',
  });
  const renamed = await api('PATCH', `/groups/${child.email}`, {
    body: { email: `new@${P}` },
  });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.json().email, `new@${P}`);
  assert.deepEqual(renamed.json().aliases, [`old@${P}`]);
  const byOld = await api('GET', `/groups/old@${P}`);
  assert.equal(byOld.json().id, child.id);
  assert.equal(
    row<{ email: string }>(
      domain.db
        .prepare(
          'SELECT email FROM group_members WHERE group_id = ? AND member_id = ?',
        )
        .get(parent.id, child.id),
    )!.email,
    `new@${P}`,
  );
  // During the delay the lagged link still holds the old address, and both addresses find the parent.
  for (const key of [`old@${P}`, `new@${P}`, child.id])
    for (const query of [
      { userKey: key },
      { customer: 'my_customer', query: `memberKey=${key}` },
    ])
      assert.deepEqual(
        (await api('GET', '/groups', { query }))
          .json()
          .groups?.map((group: { email: string }) => group.email),
        [`parent@${P}`],
        JSON.stringify(query),
      );
  // Lists lag the rename: the parent link shows the new address after the delay.
  await clock.advance(D);
  const parents = (
    await api('GET', '/groups', { query: { userKey: `old@${P}` } })
  )
    .json()
    .groups.map((group: { email: string }) => group.email);
  assert.deepEqual(parents, [`parent@${P}`]);
  // Moving back to the alias swaps the two addresses.
  const back = await api('PATCH', `/groups/${child.id}`, {
    body: { email: `old@${P}` },
  });
  assert.equal(back.json().email, `old@${P}`);
  assert.deepEqual(back.json().aliases, [`new@${P}`]);
  addTestGroup(domain.db, { email: `busy@${P}` });
  assert.equal(
    (
      await api('PATCH', `/groups/${child.id}`, {
        body: { email: `busy@${P}` },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api('PATCH', `/groups/${child.id}`, {
        body: { email: 'x@elsewhere.test' },
      })
    ).status,
    400,
  );
});

test('delete removes the group, its aliases, its members, and its parent links', async (t) => {
  const { clock, domain, api, P, user, listed } = await setup(t);
  const child = addTestGroup(domain.db, { email: `child@${P}` });
  const parent = addTestGroup(domain.db, { email: `parent@${P}` });
  domain.db
    .prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)')
    .run(`kid@${P}`, child.id);
  addTestMember(domain.db, {
    groupId: child.id,
    memberId: user.id,
    email: user.primary_email,
  });
  addTestMember(domain.db, {
    groupId: parent.id,
    memberId: child.id,
    email: child.email,
    type: 'GROUP',
  });
  assert.equal(
    (await api('GET', `/groups/${parent.id}`)).json().directMembersCount,
    '1',
  );
  const deleted = await api('DELETE', `/groups/${child.email}`);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, '');
  assert.equal((await api('GET', `/groups/${child.id}`)).status, 404);
  assert.equal((await api('GET', `/groups/kid@${P}`)).status, 404);
  assert.equal(
    (await api('GET', `/groups/${parent.id}`)).json().directMembersCount,
    '0',
  );
  assert.equal(
    rows(
      domain.db
        .prepare(
          'SELECT 1 FROM group_members WHERE group_id = ? OR member_id = ?',
        )
        .all(child.id, child.id),
    ).length,
    0,
  );
  assert.ok((await listed()).includes(`child@${P}`));
  await clock.advance(D);
  assert.ok(!(await listed()).includes(`child@${P}`));
});

test('writes need a group write scope and a visible group', async (t) => {
  const { harness, domain, P } = await setup(t);
  const group = addTestGroup(domain.db, { email: `scoped@${P}` });
  const reader = directoryClient(
    harness,
    grantToken(harness, domain, READ_SCOPES),
  );
  assert.equal(
    (await reader('POST', '/groups', { body: { email: `r@${P}` } })).status,
    403,
  );
  const writer = directoryClient(
    harness,
    grantToken(harness, domain, WRITE_SCOPES.group),
  );
  assert.equal(
    (await writer('POST', '/groups', { body: { email: `w@${P}` } })).status,
    200,
  );
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: group.id,
  });
  for (const [method, body] of [
    ['PATCH', { name: 'x' }],
    ['PUT', { name: 'x' }],
    ['DELETE', undefined],
  ] as const)
    assert.equal(
      (await writer(method, `/groups/${group.email}`, { body })).status,
      404,
      method,
    );
});
