import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { saveBeforeImage } from '../store/lag.ts';
import { row } from '../store/sqlite.ts';
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
  // Seeded groups would change every expected list, so each test starts empty.
  domain.db.exec(
    'DELETE FROM groups; DELETE FROM group_members; DELETE FROM group_aliases;',
  );
  const P = domain.spec.primaryDomain;
  const art = addTestGroup(domain.db, {
    email: `art-club@${P}`,
    name: 'Art Club',
  });
  const band = addTestGroup(domain.db, { email: `band@${P}`, name: 'Band' });
  const chess = addTestGroup(domain.db, {
    email: `chess@${P}`,
    name: 'Chess Team',
  });
  domain.db
    .prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)')
    .run(`painters@${P}`, art.id);
  const user = row<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        'SELECT id, primary_email FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 1',
      )
      .get(),
  )!;
  addTestMember(domain.db, {
    groupId: art.id,
    memberId: user.id,
    email: user.primary_email,
  });
  addTestMember(domain.db, {
    groupId: band.id,
    memberId: user.id,
    email: user.primary_email,
  });
  addTestMember(domain.db, {
    groupId: art.id,
    memberId: chess.id,
    email: chess.email,
    type: 'GROUP',
  });
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_SCOPES),
  );
  const emails = async (query: Record<string, string | number>) => {
    const response = await api('GET', '/groups', { query });
    assert.equal(response.status, 200, response.text);
    return (response.json().groups ?? []).map(
      (group: { email: string }) => group.email,
    );
  };
  return { clock, harness, domain, P, art, band, chess, user, api, emails };
}

test('groups.get answers by email, alias, and ID with the group resource', async (t) => {
  const { api, P, art } = await setup(t);
  for (const key of [`ART-CLUB@${P}`, `painters@${P}`, art.id]) {
    const response = await api('GET', `/groups/${encodeURIComponent(key)}`);
    assert.equal(response.status, 200, key);
    const body = response.json();
    assert.equal(typeof body.etag, 'string');
    delete body.etag;
    assert.deepEqual(body, {
      kind: 'admin#directory#group',
      id: art.id,
      email: `art-club@${P}`,
      name: 'Art Club',
      description: '',
      directMembersCount: '2',
      adminCreated: true,
      aliases: [`painters@${P}`],
    });
  }
  const missing = await api('GET', `/groups/nobody@${P}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.message, 'Resource Not Found: groupKey');
});

test('a group hidden by a remove-entity fault answers 404 and leaves lists', async (t) => {
  const { harness, domain, api, emails, band } = await setup(t);
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: band.id,
  });
  assert.equal((await api('GET', `/groups/${band.email}`)).status, 404);
  assert.ok(!(await emails({ customer: 'my_customer' })).includes(band.email));
});

test('groups.list pages in email order in both directions', async (t) => {
  const { api, emails, P } = await setup(t);
  assert.deepEqual(await emails({ customer: 'my_customer' }), [
    `art-club@${P}`,
    `band@${P}`,
    `chess@${P}`,
  ]);
  assert.deepEqual(
    await emails({
      customer: 'my_customer',
      orderBy: 'email',
      sortOrder: 'DESCENDING',
    }),
    [`chess@${P}`, `band@${P}`, `art-club@${P}`],
  );
  const first = (
    await api('GET', '/groups', {
      query: { customer: 'my_customer', maxResults: 2 },
    })
  ).json();
  assert.equal(first.groups.length, 2);
  const second = (
    await api('GET', '/groups', {
      query: {
        customer: 'my_customer',
        maxResults: 2,
        pageToken: first.nextPageToken,
      },
    })
  ).json();
  assert.deepEqual(
    second.groups.map((group: { email: string }) => group.email),
    [`chess@${P}`],
  );
  assert.equal(second.nextPageToken, undefined);
  const foreign = await api('GET', '/groups', {
    query: { domain: P, maxResults: 2, pageToken: first.nextPageToken },
  });
  assert.equal(foreign.status, 400);
  assert.equal(
    (
      await api('GET', '/groups', {
        query: { customer: 'my_customer', maxResults: 201 },
      })
    ).status,
    400,
  );
});

test('groups.list requires customer, domain, or userKey, and rejects customer with userKey', async (t) => {
  const { api, emails, domain, P, user } = await setup(t);
  assert.equal((await api('GET', '/groups')).status, 400);
  assert.equal(
    (
      await api('GET', '/groups', {
        query: { customer: 'my_customer', userKey: user.primary_email },
      })
    ).status,
    400,
  );
  assert.deepEqual(await emails({ domain: P }), [
    `art-club@${P}`,
    `band@${P}`,
    `chess@${P}`,
  ]);
  assert.deepEqual(await emails({ domain: P, customer: 'my_customer' }), [
    `art-club@${P}`,
    `band@${P}`,
    `chess@${P}`,
  ]);
  assert.equal(
    (await api('GET', '/groups', { query: { domain: 'elsewhere.test' } }))
      .status,
    403,
  );
  assert.equal(
    (
      await api('GET', '/groups', {
        query: { domain: domain.spec.aliasDomain },
      })
    ).status,
    403,
  );
});

test('userKey and memberKey match direct memberships of users and groups', async (t) => {
  const { api, emails, P, user, chess } = await setup(t);
  assert.deepEqual(await emails({ userKey: user.primary_email }), [
    `art-club@${P}`,
    `band@${P}`,
  ]);
  assert.deepEqual(await emails({ userKey: user.id }), [
    `art-club@${P}`,
    `band@${P}`,
  ]);
  assert.deepEqual(await emails({ userKey: chess.email }), [`art-club@${P}`]);
  assert.equal(
    (await api('GET', '/groups', { query: { userKey: `nobody@${P}` } })).status,
    400,
  );
  assert.equal(
    (await api('GET', '/groups', { query: { userKey: 'parent@home.test' } }))
      .status,
    400,
  );
  assert.deepEqual(
    await emails({
      customer: 'my_customer',
      query: `memberKey=${user.primary_email}`,
    }),
    [`art-club@${P}`, `band@${P}`],
  );
  assert.deepEqual(
    await emails({ customer: 'my_customer', query: `memberKey=nobody@${P}` }),
    [],
  );
});

test('query searches email and name and rejects other syntax', async (t) => {
  const { api, emails, P } = await setup(t);
  const search = (query: string) => emails({ customer: 'my_customer', query });
  assert.deepEqual(await search(`email=BAND@${P}`), [`band@${P}`]);
  assert.deepEqual(await search('email:ch*'), [`chess@${P}`]);
  assert.deepEqual(await search("name='art club'"), [`art-club@${P}`]);
  assert.deepEqual(await search('name:Ba*'), [`band@${P}`]);
  assert.deepEqual(await search('name:Club*'), []);
  for (const query of [
    'band',
    'name:Band',
    'description=x',
    `memberKey=a@${P} email:a*`,
  ]) {
    const response = await api('GET', '/groups', {
      query: { customer: 'my_customer', query },
    });
    assert.equal(response.status, 400, query);
    assert.match(response.json().error.message, /^Invalid Input: /);
  }
});

test('lists lag writes while get answers at once', async (t) => {
  const { clock, harness, domain, api, emails, P, band, user } = await setup(t);
  const now = harness.mock.clock.now();
  // A new group, as an insert would write it.
  saveBeforeImage(domain.db, 'groups', 'new-group-id', now, D);
  domain.db
    .prepare(
      "INSERT INTO groups (id, email, name, description, admin_created, created_at) VALUES ('new-group-id', ?, 'Drama', '', 1, ?)",
    )
    .run(`drama@${P}`, now);
  // A new membership in band, as members.insert would write it.
  const nextId = Number(
    row<{ n: number }>(
      domain.db
        .prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM group_members')
        .get(),
    )!.n,
  );
  saveBeforeImage(domain.db, 'group_members', nextId, now, D);
  domain.db
    .prepare(
      "INSERT INTO group_members (id, group_id, member_id, email, type, role, delivery, added_at) VALUES (?, ?, 'x1', ?, 'USER', 'MEMBER', 'ALL_MAIL', ?)",
    )
    .run(nextId, band.id, `x1@${P}`, now);
  assert.ok(
    !(await emails({ customer: 'my_customer' })).includes(`drama@${P}`),
  );
  assert.equal((await api('GET', `/groups/drama@${P}`)).status, 200);
  const listedBand = async () =>
    (
      await api('GET', '/groups', {
        query: { customer: 'my_customer', query: `email=${band.email}` },
      })
    ).json().groups[0].directMembersCount;
  assert.equal(await listedBand(), '1');
  assert.equal(
    (await api('GET', `/groups/${band.email}`)).json().directMembersCount,
    '2',
  );
  assert.deepEqual(await emails({ userKey: user.primary_email }), [
    `art-club@${P}`,
    `band@${P}`,
  ]);
  await clock.advance(D);
  assert.ok((await emails({ customer: 'my_customer' })).includes(`drama@${P}`));
  assert.equal(await listedBand(), '2');
});
