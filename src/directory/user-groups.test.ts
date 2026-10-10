import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_WRITE_SCOPES } from '../auth/scopes.ts';
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
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: { userCreatesPerSecond: 1000 },
  });
  const P = domain.spec.primaryDomain;
  const user = row<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        'SELECT id, primary_email FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 1',
      )
      .get(),
  )!;
  const groups = Array.from({ length: 5 }, (_, n) =>
    addTestGroup(domain.db, { email: `g${n}@${P}` }),
  );
  groups.forEach((group, n) =>
    addTestMember(domain.db, {
      groupId: group.id,
      memberId: user.id,
      email: user.primary_email,
      role: n === 0 ? 'OWNER' : 'MEMBER',
      delivery: n === 1 ? 'DIGEST' : 'ALL_MAIL',
    }),
  );
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const memberships = () =>
    rows<{ group_id: string; email: string; role: string; delivery: string }>(
      domain.db
        .prepare(
          'SELECT group_id, email, role, delivery FROM group_members WHERE member_id = ? ORDER BY group_id',
        )
        .all(user.id),
    );
  const listedIds = async (group: { email: string }) =>
    (
      (await api('GET', `/groups/${group.email}/members`)).json().members ?? []
    ).map((member: { id: string }) => member.id);
  return {
    clock,
    harness,
    domain,
    P,
    user,
    groups,
    api,
    memberships,
    listedIds,
  };
}

test('delete removes memberships, and undelete restores them except in deleted groups', async (t) => {
  const { clock, domain, user, groups, api, memberships, listedIds } =
    await setup(t);
  const before = memberships();
  assert.equal(before.length, 5);
  assert.equal((await api('DELETE', `/users/${user.id}`)).status, 204);
  assert.deepEqual(memberships(), []);
  const saved = JSON.parse(
    row<{ memberships: string }>(
      domain.db
        .prepare('SELECT memberships FROM deleted_users WHERE id = ?')
        .get(user.id),
    )!.memberships,
  ) as { group_id: string; role: string; delivery: string }[];
  assert.equal(saved.length, 5);
  assert.equal(
    (await api('GET', `/groups/${groups[0].email}/members/${user.id}`)).status,
    404,
  );
  assert.deepEqual(await listedIds(groups[0]), [user.id]);
  assert.equal((await api('DELETE', `/groups/${groups[4].email}`)).status, 204);
  const restored = await api('POST', `/users/${user.id}/undelete`, {
    body: { orgUnitPath: '/' },
  });
  assert.equal(restored.status, 204, restored.text);
  const after = memberships();
  assert.deepEqual(
    after.map((m) => m.group_id),
    before.map((m) => m.group_id).filter((id) => id !== groups[4].id),
  );
  assert.equal(after.find((m) => m.group_id === groups[0].id)!.role, 'OWNER');
  assert.equal(
    after.find((m) => m.group_id === groups[1].id)!.delivery,
    'DIGEST',
  );
  assert.equal(
    (await api('GET', `/groups/${groups[0].email}/members/${user.id}`)).status,
    200,
  );
  await clock.advance(D);
  assert.deepEqual(await listedIds(groups[0]), [user.id]);
});

test('a primaryEmail change updates the member email in every membership', async (t) => {
  const { clock, domain, P, user, groups, api, memberships } = await setup(t);
  const renamed = `renamed.${user.id.slice(-4)}@${P}`;
  const response = await api('PATCH', `/users/${user.id}`, {
    body: { primaryEmail: renamed },
  });
  assert.equal(response.status, 200, response.text);
  assert.ok(memberships().every((m) => m.email === renamed));
  const got = await api('GET', `/groups/${groups[2].email}/members/${renamed}`);
  assert.equal(got.json().email, renamed);
  assert.equal(
    row<{ n: number }>(
      domain.db
        .prepare(
          'SELECT count(*) AS n FROM group_members_prior WHERE member_id = ?',
        )
        .get(user.id),
    )!.n,
    5,
  );
  // During the delay the lagged memberships still hold the old address.
  const during = (await api('GET', '/groups', { query: { userKey: renamed } }))
    .json()
    .groups?.map((group: { email: string }) => group.email);
  assert.deepEqual(
    during,
    groups.map((group) => group.email),
  );
  await clock.advance(D);
  const byUser = (await api('GET', '/groups', { query: { userKey: renamed } }))
    .json()
    .groups.map((group: { email: string }) => group.email);
  assert.equal(byUser.length, 5);
});

test('user addresses stay unique against groups and group aliases', async (t) => {
  const { domain, P, user, groups, api } = await setup(t);
  domain.db
    .prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)')
    .run(`g0-alias@${P}`, groups[0].id);
  const insert = (email: string) =>
    api('POST', '/users', {
      body: {
        primaryEmail: email,
        name: { givenName: 'New', familyName: 'Person' },
        password: 'correct horse battery',
      },
    });
  assert.equal((await insert(`g1@${P}`)).status, 409);
  assert.equal((await insert(`g0-alias@${P}`)).status, 409);
  assert.equal(
    (
      await api('PATCH', `/users/${user.id}`, {
        body: { primaryEmail: `g2@${P}` },
      })
    ).status,
    409,
  );
  assert.equal((await api('DELETE', `/users/${user.id}`)).status, 204);
  addTestGroup(domain.db, { email: user.primary_email });
  assert.equal(
    (
      await api('POST', `/users/${user.id}/undelete`, {
        body: { orgUnitPath: '/' },
      })
    ).status,
    409,
  );
});

test('a suspension changes the member status at once in get and after the delay in lists', async (t) => {
  const { clock, user, groups, api } = await setup(t);
  assert.equal(
    (await api('PATCH', `/users/${user.id}`, { body: { suspended: true } }))
      .status,
    200,
  );
  const path = `/groups/${groups[3].email}/members`;
  assert.equal(
    (await api('GET', `${path}/${user.id}`)).json().status,
    'SUSPENDED',
  );
  assert.equal((await api('GET', path)).json().members[0].status, 'ACTIVE');
  await clock.advance(D);
  assert.equal((await api('GET', path)).json().members[0].status, 'SUSPENDED');
});
