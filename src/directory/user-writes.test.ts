import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { row } from '../store/sqlite.ts';
import {
  directoryClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const D = 300_000;

async function setup(t: import('node:test').TestContext, scale = 1) {
  const clock = fakeClock();
  const harness = await startHarness({
    clock,
    timing: { scale, delays: false },
  });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const primary = domain.spec.primaryDomain;
  const user = row<{
    id: string;
    primary_email: string;
    org_unit_path: string;
  }>(
    domain.db
      .prepare(
        'SELECT id, primary_email, org_unit_path FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 1',
      )
      .get(),
  )!;
  const second = row<{ id: string; primary_email: string }>(
    domain.db
      .prepare(
        'SELECT id, primary_email FROM users WHERE is_admin = 0 ORDER BY ord LIMIT 1 OFFSET 1',
      )
      .get(),
  )!;
  const alias = `nickname.${second.id.slice(-6)}@${primary}`;
  domain.db
    .prepare('INSERT INTO user_aliases (alias, user_id) VALUES (?, ?)')
    .run(alias, second.id);
  const aliased = { ...second, alias };
  const usersOu = row<{ path: string }>(
    domain.db
      .prepare(
        "SELECT path FROM orgunits WHERE kind = 'users' AND path != ? ORDER BY ord DESC LIMIT 1",
      )
      .get(user.org_unit_path),
  )!.path;
  const listedEmails = async (query: Record<string, string> = {}) =>
    (
      (
        await api('GET', '/users', {
          query: { customer: 'my_customer', maxResults: 500, ...query },
        })
      ).json().users ?? []
    ).map((entry: { primaryEmail: string }) => entry.primaryEmail);
  const fresh = (local = 'New.Teacher') => ({
    primaryEmail: `${local}@${primary}`,
    name: { givenName: 'New', familyName: 'Teacher' },
    password: 'correct horse battery',
  });
  return {
    clock,
    harness,
    domain,
    api,
    primary,
    user,
    aliased,
    usersOu,
    listedEmails,
    fresh,
  };
}

test('insert creates a user that get finds at once and lists show after the delay', async (t) => {
  const { clock, api, primary, listedEmails, fresh } = await setup(t);
  const response = await api('POST', '/users', { body: fresh() });
  assert.equal(response.status, 200, response.text);
  const created = response.json();
  assert.match(created.id, /^\d{21}$/);
  assert.equal(created.primaryEmail, `new.teacher@${primary}`);
  assert.equal(created.name.fullName, 'New Teacher');
  assert.equal(created.orgUnitPath, '/');
  assert.equal(created.isAdmin, false);
  assert.equal(created.password, undefined);
  assert.equal(created.creationTime, new Date(clock.now()).toISOString());
  assert.equal(
    (await api('GET', `/users/${created.primaryEmail}`)).status,
    200,
  );
  assert.equal((await listedEmails()).includes(created.primaryEmail), false);
  await clock.advance(D);
  assert.equal((await listedEmails()).includes(created.primaryEmail), true);
});

test('insert stores the optional fields', async (t) => {
  const { api, usersOu, fresh } = await setup(t);
  const externalIds = [{ value: 'S-1001', type: 'organization' }];
  const created = (
    await api('POST', '/users', {
      body: {
        ...fresh(),
        orgUnitPath: usersOu,
        suspended: true,
        changePasswordAtNextLogin: true,
        externalIds,
      },
    })
  ).json();
  assert.equal(created.orgUnitPath, usersOu);
  assert.equal(created.suspended, true);
  assert.equal(created.suspensionReason, 'ADMIN');
  assert.equal(created.changePasswordAtNextLogin, true);
  assert.deepEqual(created.externalIds, externalIds);
});

test('insert answers 409 for an address in use as a primary email or an alias', async (t) => {
  const { api, user, aliased, fresh } = await setup(t);
  for (const address of [user.primary_email, aliased.alias]) {
    const response = await api('POST', '/users', {
      body: { ...fresh(), primaryEmail: address },
    });
    assert.equal(response.status, 409, address);
    assert.equal(response.json().error.errors[0].reason, 'duplicate');
  }
});

test('insert validates its fields with 400', async (t) => {
  const { domain, api, fresh } = await setup(t);
  const base = fresh();
  const cases: Record<string, unknown>[] = [
    { ...base, primaryEmail: undefined },
    { ...base, primaryEmail: 'not-an-address' },
    { ...base, primaryEmail: 'someone@elsewhere.test' },
    { ...base, primaryEmail: `someone@${domain.spec.aliasDomain}` },
    { ...base, name: undefined },
    { ...base, name: { givenName: '', familyName: 'Teacher' } },
    { ...base, name: { givenName: 'g'.repeat(61), familyName: 'Teacher' } },
    { ...base, password: undefined },
    { ...base, password: 'short' },
    { ...base, hashFunction: 'SHA-256' },
    { ...base, orgUnitPath: '/No/Such/Unit' },
    { ...base, suspended: 'yes' },
    { ...base, externalIds: 'S-1' },
  ];
  for (const body of cases)
    assert.equal(
      (await api('POST', '/users', { body })).status,
      400,
      JSON.stringify(body),
    );
});

test('a hashed password skips the length rule', async (t) => {
  const { api, fresh } = await setup(t);
  const response = await api('POST', '/users', {
    body: { ...fresh(), password: '$1$x$y', hashFunction: 'crypt' },
  });
  assert.equal(response.status, 200, response.text);
});

test('a read-only token and a non-administrator cannot insert', async (t) => {
  const { harness, domain, user, fresh } = await setup(t);
  const readOnly = directoryClient(
    harness,
    grantToken(harness, domain, READ_SCOPES),
  );
  assert.equal(
    (await readOnly('POST', '/users', { body: fresh() })).status,
    403,
  );
  const teacher = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES, user.primary_email),
  );
  const denied = await teacher('POST', '/users', { body: fresh() });
  assert.equal(denied.status, 403);
  assert.equal(
    denied.json().error.message,
    'Not Authorized to access this resource/api',
  );
});
