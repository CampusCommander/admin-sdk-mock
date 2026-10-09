import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES } from '../auth/scopes.ts';
import { NO_OVERRIDES } from '../http/types.ts';
import { row } from '../store/sqlite.ts';
import {
  adminOf,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const SPEC = {
  tier: 'small',
  seed: 'users',
  layout: 'school-first',
  counts: { schools: 2, students: 400, staff: 60, devices: 50 },
};
const LIST = '/admin/directory/v1/users';

interface User {
  id: string;
  primaryEmail: string;
  name: { familyName: string };
  isAdmin?: boolean;
  lastLoginTime?: string;
}

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const token = grantToken(harness, domain, READ_SCOPES);
  const list = (query: Record<string, string | number>, bearer = token) =>
    harness.request({
      host: 'admin.googleapis.com',
      path: LIST,
      token: bearer,
      query,
    });
  const all = async (query: Record<string, string | number>) => {
    const users: User[] = [];
    let pageToken: string | undefined;
    do {
      const response = await list({
        customer: 'my_customer',
        ...query,
        ...(pageToken ? { pageToken } : {}),
      });
      assert.equal(response.status, 200, response.text);
      users.push(...(response.json().users ?? []));
      pageToken = response.json().nextPageToken;
    } while (pageToken);
    return users;
  };
  const count = (where: string, ...params: (string | number)[]) =>
    Number(
      row<{ n: number }>(
        domain.db
          .prepare(`SELECT count(*) AS n FROM users WHERE ${where}`)
          .get(...params),
      )?.n,
    );
  const one = <T>(sql: string) => row<T>(domain.db.prepare(sql).get())!;
  return { harness, domain, token, list, all, count, one };
}

test('paging returns every user exactly once', async (t) => {
  const { all, count } = await setup(t);
  const users = await all({ maxResults: 500 });
  assert.equal(users.length, count('1 = 1'));
  assert.equal(new Set(users.map((user) => user.id)).size, users.length);
});

test('the domain parameter limits users to one domain', async (t) => {
  const { all, list, domain } = await setup(t);
  const response = await list({
    domain: domain.spec.primaryDomain,
    maxResults: 500,
  });
  assert.equal(response.status, 200);
  const users = response.json().users as User[];
  assert.ok(
    users.every((user) =>
      user.primaryEmail.endsWith(`@${domain.spec.primaryDomain}`),
    ),
  );
  assert.ok((await all({})).length >= users.length);
});

test('missing customer and domain, and bad page sizes, fail with 400', async (t) => {
  const { list } = await setup(t);
  assert.equal((await list({})).status, 400);
  const tooMany = await list({ customer: 'my_customer', maxResults: 501 });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json().error.message, /\[1, 500\]/);
  assert.equal(
    (await list({ customer: 'my_customer', maxResults: 0 })).status,
    400,
  );
});

test('orderBy familyName sorts across pages', async (t) => {
  const { all } = await setup(t);
  const users = await all({ orderBy: 'familyName', maxResults: 100 });
  const names = users.map((user) => user.name.familyName);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
});

test('query clauses match the stored data', async (t) => {
  const { all, count, one, domain } = await setup(t);
  assert.equal((await all({ query: `email=${adminOf(domain)}` })).length, 1);
  assert.equal((await all({ query: 'isAdmin=true' })).length, 3);
  assert.equal(
    (await all({ query: 'isSuspended=true' })).length,
    count('suspended = 1'),
  );
  const alias = one<{ alias: string; user_id: string }>(
    'SELECT alias, user_id FROM user_aliases LIMIT 1',
  );
  if (alias) {
    const found = await all({ query: `email=${alias.alias}` });
    assert.deepEqual(
      found.map((user) => user.id),
      [alias.user_id],
    );
  }
  const staffOu = one<{ org_unit_path: string }>(
    "SELECT org_unit_path FROM users WHERE role = 'staff' AND org_unit_path LIKE '% %' LIMIT 1",
  );
  if (staffOu) {
    const path = staffOu.org_unit_path;
    const found = await all({ query: `orgUnitPath='${path}'` });
    assert.equal(
      found.length,
      count(
        'org_unit_path = ? OR substr(org_unit_path, 1, ?) = ?',
        path,
        path.length + 1,
        `${path}/`,
      ),
    );
  }
  const family = one<{ family_name: string }>(
    'SELECT family_name FROM users LIMIT 1',
  ).family_name;
  const prefix = await all({ query: `familyName:${family.slice(0, 3)}*` });
  assert.ok(
    prefix.every((user) =>
      user.name.familyName
        .toLowerCase()
        .startsWith(family.slice(0, 3).toLowerCase()),
    ),
  );
  const external = await all({ query: 'externalId=E100000' });
  assert.equal(external.length, count("external_id = 'E100000'"));
  assert.equal(
    (await all({ query: "orgUnitPath='/'" })).length,
    count('1 = 1'),
  );
});

test('an unsupported query field fails with 400', async (t) => {
  const { list } = await setup(t);
  assert.equal(
    (await list({ customer: 'my_customer', query: 'robot=1' })).status,
    400,
  );
});

test('a non-administrator reads only the public view', async (t) => {
  const { harness, domain, list, one } = await setup(t);
  const staff = one<{ primary_email: string }>(
    'SELECT primary_email FROM users WHERE is_admin = 0 LIMIT 1',
  ).primary_email;
  const token = grantToken(harness, domain, READ_SCOPES, staff);
  assert.equal((await list({ customer: 'my_customer' }, token)).status, 403);
  const open = await list(
    { customer: 'my_customer', viewType: 'domain_public' },
    token,
  );
  assert.equal(open.status, 200);
  assert.ok(
    (open.json().users as User[]).every((user) => user.isAdmin === undefined),
  );
});

test('get finds users by email, alias, and ID', async (t) => {
  const { harness, token, domain, one } = await setup(t);
  const get = (key: string) =>
    harness.request({
      host: 'admin.googleapis.com',
      path: `${LIST}/${encodeURIComponent(key)}`,
      token,
    });
  const admin = (await get(adminOf(domain))).json();
  assert.equal(admin.isAdmin, true);
  assert.equal((await get(admin.id)).json().primaryEmail, adminOf(domain));
  const alias = one<{ alias: string; user_id: string } | undefined>(
    'SELECT alias, user_id FROM user_aliases LIMIT 1',
  );
  if (alias) assert.equal((await get(alias.alias)).json().id, alias.user_id);
  const missing = await get(`nobody@${domain.spec.primaryDomain}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.message, 'Resource Not Found: userKey');
});

test('a user who never signed in reports the epoch as the last login', async (t) => {
  const { harness, token, one } = await setup(t);
  const never = one<{ primary_email: string } | undefined>(
    'SELECT primary_email FROM users WHERE last_login_time IS NULL LIMIT 1',
  );
  assert.ok(never, 'The seed includes a user who never signed in.');
  const user = (
    await harness.request({
      host: 'admin.googleapis.com',
      path: `${LIST}/${never.primary_email}`,
      token,
    })
  ).json();
  assert.equal(user.lastLoginTime, '1970-01-01T00:00:00.000Z');
});

test('hidden users disappear', async (t) => {
  const { harness, all, domain, count } = await setup(t);
  harness.mock.overrides = {
    ...NO_OVERRIDES,
    hidden: () => new Set([adminOf(domain)]),
  };
  assert.equal((await all({ maxResults: 500 })).length, count('1 = 1') - 1);
});

function forge(token: string, cursor: unknown): string {
  const { f } = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  return Buffer.from(JSON.stringify({ f, c: cursor })).toString('base64url');
}

test('a forged page token with a short cursor answers 400, not 500', async (t) => {
  const { list } = await setup(t);
  const query = { customer: 'my_customer', maxResults: 5 };
  const token = (await list(query)).json().nextPageToken;
  assert.equal((await list({ ...query, pageToken: token })).status, 200);
  for (const cursor of [[], ['x'], ['x', 'y', 'z']]) {
    const response = await list({ ...query, pageToken: forge(token, cursor) });
    assert.equal(response.status, 400, response.text);
  }
});
