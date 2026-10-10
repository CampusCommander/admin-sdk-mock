import assert from 'node:assert/strict';
import test from 'node:test';
import {
  READ_SCOPES,
  READ_WRITE_SCOPES,
  WRITE_SCOPES,
} from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { NO_OVERRIDES, type Call } from '../http/types.ts';
import { outsideMemberId } from '../store/group-lookup.ts';
import { rows } from '../store/sqlite.ts';
import { addTestGroup, addTestMember } from '../testing/groups.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { deleteMember } from './member-writes.ts';

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
  const [u1, u2] = rows<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        'SELECT id, primary_email FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 2',
      )
      .all(),
  );
  const team = addTestGroup(domain.db, { email: `team@${P}` });
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const members = (key: string) => `/groups/${key}/members`;
  const listedIds = async (key: string) =>
    ((await api('GET', members(key))).json().members ?? []).map(
      (m: { id: string }) => m.id,
    );
  return { clock, harness, domain, P, u1, u2, team, api, members, listedIds };
}

test('insert adds a user member that get shows at once and lists show after the delay', async (t) => {
  const { clock, domain, P, u1, team, api, members, listedIds } =
    await setup(t);
  domain.db
    .prepare('INSERT INTO user_aliases (alias, user_id) VALUES (?, ?)')
    .run(`alias.${u1.id.slice(-4)}@${P}`, u1.id);
  const added = await api('POST', members(team.email), {
    body: { email: `ALIAS.${u1.id.slice(-4)}@${P}` },
  });
  assert.equal(added.status, 200, added.text);
  const body = added.json();
  delete body.etag;
  assert.deepEqual(body, {
    kind: 'admin#directory#member',
    id: u1.id,
    email: u1.primary_email,
    role: 'MEMBER',
    type: 'USER',
    status: 'ACTIVE',
    delivery_settings: 'ALL_MAIL',
  });
  assert.equal(
    (await api('GET', `${members(team.email)}/${u1.id}`)).status,
    200,
  );
  assert.deepEqual(await listedIds(team.email), []);
  await clock.advance(D);
  assert.deepEqual(await listedIds(team.email), [u1.id]);
});

test('insert infers group, outside, and customer members and keeps the role and delivery', async (t) => {
  const { domain, P, team, api, members } = await setup(t);
  const child = addTestGroup(domain.db, { email: `child@${P}` });
  const group = await api('POST', members(team.id), {
    body: { email: child.email, role: 'MANAGER', delivery_settings: 'DIGEST' },
  });
  assert.equal(group.json().type, 'GROUP');
  assert.equal(group.json().role, 'MANAGER');
  assert.equal(group.json().delivery_settings, 'DIGEST');
  const outside = await api('POST', members(team.id), {
    body: { email: 'Guest.One@Home.test' },
  });
  assert.equal(outside.json().type, 'USER');
  assert.equal(outside.json().id, outsideMemberId('guest.one@home.test'));
  assert.equal(outside.json().email, 'guest.one@home.test');
  const customer = await api('POST', members(team.id), {
    body: { id: domain.customerId },
  });
  assert.equal(customer.json().type, 'CUSTOMER');
  assert.equal(customer.json().email, undefined);
});

test('insert rejects missing keys, unknown values, unknown members, and duplicates', async (t) => {
  const { P, u1, team, api, members } = await setup(t);
  const post = (body: unknown, key = team.email) =>
    api('POST', members(key), { body });
  const missing = await post({ role: 'OWNER' });
  assert.equal(missing.status, 400);
  assert.equal(missing.json().error.message, 'Invalid Input: memberKey');
  assert.equal(
    (await post({ email: u1.primary_email, role: 'BOSS' })).status,
    400,
  );
  assert.equal(
    (await post({ email: u1.primary_email, delivery_settings: 'WEEKLY' }))
      .status,
    400,
  );
  const unknown = await post({ email: `nobody@${P}` });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().error.message, 'Resource Not Found: memberKey');
  assert.equal((await post({ id: '123' })).status, 404);
  assert.equal(
    (await post({ email: u1.primary_email }, `missing@${P}`)).status,
    404,
  );
  assert.equal((await post({ email: u1.primary_email })).status, 200);
  const again = await post({ id: u1.id });
  assert.equal(again.status, 409);
  assert.equal(again.json().error.message, 'Member already exists.');
});

test('insert rejects every cycle, including one through a link inside the nesting delay', async (t) => {
  const { harness, domain, P, team, api, members } = await setup(t);
  const cyclic = async (parent: string, child: string) => {
    const response = await api('POST', members(parent), {
      body: { email: child },
    });
    assert.equal(response.status, 400, `${parent} <- ${child}`);
    assert.equal(
      response.json().error.message,
      'Cyclic memberships not allowed.',
    );
  };
  await cyclic(team.email, team.email);
  const other = addTestGroup(domain.db, { email: `other@${P}` });
  addTestMember(domain.db, {
    groupId: team.id,
    memberId: other.id,
    email: other.email,
    type: 'GROUP',
  });
  await cyclic(other.email, team.email);
  const chain = Array.from({ length: 10 }, (_, n) =>
    addTestGroup(domain.db, { email: `level-${n}@${P}` }),
  );
  for (let n = 0; n < 9; n++)
    addTestMember(domain.db, {
      groupId: chain[n].id,
      memberId: chain[n + 1].id,
      email: chain[n + 1].email,
      type: 'GROUP',
      addedAt: n === 4 ? harness.mock.clock.now() : 0,
    });
  await cyclic(chain[9].email, chain[0].email);
  assert.equal(
    (
      await api('POST', members(chain[0].email), {
        body: { email: team.email },
      })
    ).status,
    200,
  );
});

test('a new group accepts members only after the ready delay', async (t) => {
  const { clock, harness, domain, P, u1, api, members } = await setup(t);
  const fresh = addTestGroup(domain.db, {
    email: `fresh@${P}`,
    createdAt: harness.mock.clock.now(),
  });
  const early = await api('POST', members(fresh.email), {
    body: { email: u1.primary_email },
  });
  assert.equal(early.status, 404);
  assert.equal(early.json().error.message, 'Resource Not Found: groupKey');
  assert.equal((await api('GET', `/groups/${fresh.email}`)).status, 200);
  assert.equal((await api('GET', members(fresh.email))).status, 200);
  await clock.advance(60_000);
  assert.equal(
    (
      await api('POST', members(fresh.email), {
        body: { email: u1.primary_email },
      })
    ).status,
    200,
  );
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: { groupReadySeconds: 0 },
  });
  const instant = addTestGroup(domain.db, {
    email: `instant@${P}`,
    createdAt: harness.mock.clock.now(),
  });
  assert.equal(
    (
      await api('POST', members(instant.email), {
        body: { email: u1.primary_email },
      })
    ).status,
    200,
  );
});

test('patch and update change only role and delivery, and lists lag the change', async (t) => {
  const { clock, domain, u1, u2, team, api, members } = await setup(t);
  addTestMember(domain.db, {
    groupId: team.id,
    memberId: u1.id,
    email: u1.primary_email,
  });
  const patched = await api(
    'PATCH',
    `${members(team.email)}/${u1.primary_email}`,
    {
      body: { role: 'OWNER', email: 'ignored@x.test' },
    },
  );
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json().role, 'OWNER');
  assert.equal(patched.json().delivery_settings, 'ALL_MAIL');
  assert.equal(patched.json().email, u1.primary_email);
  const updated = await api('PUT', `${members(team.email)}/${u1.id}`, {
    body: { delivery_settings: 'NONE' },
  });
  assert.equal(updated.json().role, 'OWNER');
  assert.equal(updated.json().delivery_settings, 'NONE');
  const listedRole = async () =>
    (await api('GET', members(team.email))).json().members[0].role;
  assert.equal(await listedRole(), 'MEMBER');
  await clock.advance(D);
  assert.equal(await listedRole(), 'OWNER');
  assert.equal(
    (
      await api('PATCH', `${members(team.email)}/${u1.id}`, {
        body: { role: 'BOSS' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api('PATCH', `${members(team.email)}/${u2.id}`, {
        body: { role: 'OWNER' },
      })
    ).status,
    404,
  );
});

test('delete removes one direct membership', async (t) => {
  const { clock, domain, P, u1, team, api, members, listedIds } =
    await setup(t);
  const child = addTestGroup(domain.db, { email: `child@${P}` });
  addTestMember(domain.db, {
    groupId: team.id,
    memberId: u1.id,
    email: u1.primary_email,
  });
  addTestMember(domain.db, {
    groupId: team.id,
    memberId: child.id,
    email: child.email,
    type: 'GROUP',
  });
  addTestMember(domain.db, {
    groupId: child.id,
    memberId: 'x',
    email: `x@${P}`,
  });
  const deleted = await api('DELETE', `${members(team.email)}/${u1.id}`);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, '');
  assert.equal(
    (await api('GET', `${members(team.email)}/${u1.id}`)).status,
    404,
  );
  assert.equal(
    (await api('DELETE', `${members(team.email)}/x@${P}`)).status,
    404,
  );
  assert.ok((await listedIds(team.email)).includes(u1.id));
  await clock.advance(D);
  assert.deepEqual(await listedIds(team.email), [child.id]);
});

test('member writes need a member write scope and a visible group', async (t) => {
  const { harness, domain, u1, team, members } = await setup(t);
  const reader = directoryClient(
    harness,
    grantToken(harness, domain, READ_SCOPES),
  );
  assert.equal(
    (
      await reader('POST', members(team.email), {
        body: { email: u1.primary_email },
      })
    ).status,
    403,
  );
  const memberWriter = directoryClient(
    harness,
    grantToken(harness, domain, [WRITE_SCOPES.member[1]]),
  );
  assert.equal(
    (
      await memberWriter('POST', members(team.email), {
        body: { email: u1.primary_email },
      })
    ).status,
    200,
  );
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: team.id,
  });
  const path = `${members(team.email)}/${u1.id}`;
  for (const [method, target, body] of [
    ['POST', members(team.email), { email: u1.primary_email }],
    ['PATCH', path, { role: 'OWNER' }],
    ['PUT', path, { role: 'OWNER' }],
    ['DELETE', path, undefined],
    ['GET', path, undefined],
    ['GET', members(team.email), undefined],
  ] as const)
    assert.equal(
      (await memberWriter(method, target, { body })).status,
      404,
      `${method} ${target}`,
    );
});

test('deleteMember reports the removed row count for the latency model', async (t) => {
  const { domain, u1, team } = await setup(t);
  addTestMember(domain.db, {
    groupId: team.id,
    memberId: u1.id,
    email: u1.primary_email,
  });
  const call = {
    route: { id: 'test', api: 'directory' },
    domain,
    access: { customerId: domain.customerId },
    overrides: NO_OVERRIDES,
    now: 0,
    scale: 1,
    params: { groupKey: team.id, memberKey: u1.id },
    request: { body: '' },
  } as unknown as Call;
  assert.deepEqual(deleteMember(call), { status: 204, scanned: 1 });
});
