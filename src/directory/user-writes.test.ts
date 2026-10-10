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
  harness.mock.domains.updateSettings(domain.customerId, {
    writes: { userCreatesPerSecond: 1000 },
  });
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

test('patch merges: absent fields stay and the full name follows the name parts', async (t) => {
  const { api, user } = await setup(t);
  const before = (await api('GET', `/users/${user.id}`)).json();
  const response = await api('PATCH', `/users/${user.id}`, {
    body: { name: { givenName: 'Renamed' } },
  });
  assert.equal(response.status, 200, response.text);
  const after = response.json();
  assert.equal(after.name.givenName, 'Renamed');
  assert.equal(after.name.familyName, before.name.familyName);
  assert.equal(after.name.fullName, `Renamed ${before.name.familyName}`);
  assert.equal(after.orgUnitPath, before.orgUnitPath);
  assert.notEqual(after.etag, before.etag);
});

test('suspension, the password flag, and external IDs follow the body', async (t) => {
  const { api, user } = await setup(t);
  const patch = async (body: unknown) =>
    (await api('PATCH', `/users/${user.id}`, { body })).json();
  let current = await patch({ suspended: true });
  assert.equal(current.suspended, true);
  assert.equal(current.suspensionReason, 'ADMIN');
  current = await patch({ suspended: false });
  assert.equal(current.suspended, false);
  assert.equal(current.suspensionReason, undefined);
  current = await patch({ changePasswordAtNextLogin: true });
  assert.equal(current.changePasswordAtNextLogin, true);
  const externalIds = [{ value: 'E-7', type: 'organization' }];
  current = await patch({ externalIds });
  assert.deepEqual(current.externalIds, externalIds);
  current = await patch({ externalIds: null });
  assert.equal(current.externalIds, undefined);
  assert.equal(
    (await api('PATCH', `/users/${user.id}`, { body: { password: 'short' } }))
      .status,
    400,
  );
});

test('a primaryEmail change keeps the old address as an alias', async (t) => {
  const { api, user, primary } = await setup(t);
  const renamed = `renamed.person@${primary}`;
  const response = await api('PATCH', `/users/${user.id}`, {
    body: { primaryEmail: renamed },
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json().primaryEmail, renamed);
  assert.ok(response.json().aliases.includes(user.primary_email));
  assert.equal(
    (await api('GET', `/users/${user.primary_email}`)).json().id,
    user.id,
  );
  assert.equal((await api('GET', `/users/${renamed}`)).json().id, user.id);
});

test('renaming to one of your own aliases swaps the two addresses', async (t) => {
  const { api, aliased } = await setup(t);
  const response = await api('PATCH', `/users/${aliased.id}`, {
    body: { primaryEmail: aliased.alias },
  });
  assert.equal(response.status, 200, response.text);
  const body = response.json();
  assert.equal(body.primaryEmail, aliased.alias);
  assert.ok(body.aliases.includes(aliased.primary_email));
  assert.equal(body.aliases.includes(aliased.alias), false);
});

test('an address in use answers 409, and bad fields answer 400', async (t) => {
  const { api, user, aliased } = await setup(t);
  assert.equal(
    (
      await api('PATCH', `/users/${user.id}`, {
        body: { primaryEmail: aliased.primary_email },
      })
    ).status,
    409,
  );
  for (const body of [
    { primaryEmail: 'someone@elsewhere.test' },
    { name: null },
    { name: { familyName: '' } },
    { orgUnitPath: '/No/Such/Unit' },
    { suspended: 'yes' },
  ])
    assert.equal(
      (await api('PATCH', `/users/${user.id}`, { body })).status,
      400,
      JSON.stringify(body),
    );
  assert.equal(
    (await api('PATCH', '/users/nobody@nowhere.test', { body: {} })).status,
    404,
  );
});

test('update behaves like patch and ignores isAdmin', async (t) => {
  const { api, user } = await setup(t);
  const before = (await api('GET', `/users/${user.id}`)).json();
  const response = await api('PUT', `/users/${user.id}`, {
    body: { isAdmin: true, name: { familyName: 'Changed' } },
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json().isAdmin, false);
  assert.equal(response.json().name.givenName, before.name.givenName);
  assert.equal(response.json().name.familyName, 'Changed');
});

test('an OU change lags in users.list', async (t) => {
  const { clock, api, user, usersOu, listedEmails } = await setup(t);
  await api('PATCH', `/users/${user.id}`, { body: { orgUnitPath: usersOu } });
  const query = { query: `orgUnitPath='${usersOu}'` };
  assert.equal((await listedEmails(query)).includes(user.primary_email), false);
  await clock.advance(D);
  assert.equal((await listedEmails(query)).includes(user.primary_email), true);
});

test('a hidden user never changes through a write', async (t) => {
  const { harness, domain, api, user } = await setup(t);
  harness.mock.faults.add(domain.customerId, {
    kind: 'remove-entity',
    entityId: user.id,
  });
  assert.equal(
    (
      await api('PATCH', `/users/${user.primary_email}`, {
        body: { name: { givenName: 'Changed' } },
      })
    ).status,
    404,
  );
  assert.notEqual(
    row<{ given_name: string }>(
      domain.db
        .prepare('SELECT given_name FROM users WHERE id = ?')
        .get(user.id),
    )!.given_name,
    'Changed',
  );
});

test('a primaryEmail change lags in list bodies, aliases included', async (t) => {
  const { clock, api, user, primary } = await setup(t);
  const renamed = `lagging.rename@${primary}`;
  await api('PATCH', `/users/${user.id}`, { body: { primaryEmail: renamed } });
  const listed = async () =>
    (
      await api('GET', '/users', {
        query: { customer: 'my_customer', maxResults: 500 },
      })
    )
      .json()
      .users.find((entry: { id: string }) => entry.id === user.id);
  const during = await listed();
  assert.equal(during.primaryEmail, user.primary_email);
  assert.equal((during.aliases ?? []).includes(user.primary_email), false);
  await clock.advance(D);
  const after = await listed();
  assert.equal(after.primaryEmail, renamed);
  assert.ok(after.aliases.includes(user.primary_email));
});

test('delete removes the user from get at once and from lists after the delay', async (t) => {
  const { clock, api, user, listedEmails } = await setup(t);
  const response = await api('DELETE', `/users/${user.primary_email}`);
  assert.equal(response.status, 204, response.text);
  assert.equal(response.text, '');
  assert.equal((await api('GET', `/users/${user.id}`)).status, 404);
  assert.equal((await listedEmails()).includes(user.primary_email), true);
  await clock.advance(D);
  assert.equal((await listedEmails()).includes(user.primary_email), false);
});

test('showDeleted lists a deleted user after the delay, with its deletion time', async (t) => {
  const { clock, api, user, listedEmails } = await setup(t);
  const deletedAt = clock.now();
  await api('DELETE', `/users/${user.id}`);
  const deleted = { showDeleted: 'true' };
  assert.equal(
    (await listedEmails(deleted)).includes(user.primary_email),
    false,
  );
  await clock.advance(D);
  const response = await api('GET', '/users', {
    query: { customer: 'my_customer', showDeleted: 'true' },
  });
  const entry = response
    .json()
    .users.find((found: { id: string }) => found.id === user.id);
  assert.equal(entry.deletionTime, new Date(deletedAt).toISOString());
});

test('undelete restores the user, its aliases, and the named OU', async (t) => {
  const { api, aliased, usersOu } = await setup(t);
  await api('DELETE', `/users/${aliased.id}`);
  const response = await api('POST', `/users/${aliased.id}/undelete`, {
    body: { orgUnitPath: usersOu },
  });
  assert.equal(response.status, 204, response.text);
  const restored = (await api('GET', `/users/${aliased.primary_email}`)).json();
  assert.equal(restored.id, aliased.id);
  assert.equal(restored.orgUnitPath, usersOu);
  assert.ok(restored.aliases.includes(aliased.alias));
  assert.equal(
    (await api('GET', `/users/${aliased.alias}`)).json().id,
    aliased.id,
  );
});

test('undelete answers 400 for an active user and 404 for an unknown user', async (t) => {
  const { api, user } = await setup(t);
  assert.equal(
    (await api('POST', `/users/${user.id}/undelete`, { body: {} })).status,
    400,
  );
  assert.equal(
    (await api('POST', '/users/100000000000000000009/undelete', { body: {} }))
      .status,
    404,
  );
});

test('the undelete window is 20 days, and the time scale shortens it', async (t) => {
  for (const scale of [1, 60]) {
    const { clock, harness, domain, api, user } = await setup(t, scale);
    await api('DELETE', `/users/${user.id}`);
    await clock.advance((20 * 86_400_000) / scale);
    // The setup token expires inside the window, so mint a fresh one.
    const later = directoryClient(
      harness,
      grantToken(harness, domain, READ_WRITE_SCOPES),
    );
    assert.equal(
      (await later('POST', `/users/${user.id}/undelete`, { body: {} })).status,
      404,
      `scale ${scale}`,
    );
  }
});

test('undelete answers 409 when another user took the address', async (t) => {
  const { api, user, fresh } = await setup(t);
  await api('DELETE', `/users/${user.id}`);
  const taken = await api('POST', '/users', {
    body: { ...fresh(), primaryEmail: user.primary_email },
  });
  assert.equal(taken.status, 200, taken.text);
  assert.equal(
    (await api('POST', `/users/${user.id}/undelete`, { body: {} })).status,
    409,
  );
});

test('makeAdmin sets administrator status, and a demoted or deleted subject loses access', async (t) => {
  const { harness, domain, api, user } = await setup(t);
  const subject = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES, user.primary_email),
  );
  const devices = () =>
    subject('GET', '/customer/my_customer/devices/chromeos');
  assert.equal((await devices()).status, 403);
  assert.equal(
    (
      await api('POST', `/users/${user.id}/makeAdmin`, {
        body: { status: true },
      })
    ).status,
    204,
  );
  assert.equal((await api('GET', `/users/${user.id}`)).json().isAdmin, true);
  assert.equal((await devices()).status, 200);
  await api('POST', `/users/${user.id}/makeAdmin`, { body: { status: false } });
  assert.equal((await devices()).status, 403);
  await api('POST', `/users/${user.id}/makeAdmin`, { body: { status: true } });
  await api('DELETE', `/users/${user.id}`);
  assert.equal((await devices()).status, 403);
  assert.equal(
    (
      await api('POST', `/users/${domain.spec.primaryDomain}/makeAdmin`, {
        body: {},
      })
    ).status,
    404,
  );
  const admin = `admin@${domain.spec.primaryDomain}`;
  assert.equal(
    (await api('POST', `/users/${admin}/makeAdmin`, { body: {} })).status,
    400,
  );
});

test('a deleted user keeps its aliases in lists until the delay passes', async (t) => {
  const { clock, api, aliased } = await setup(t);
  await api('DELETE', `/users/${aliased.id}`);
  const listedAliases = async (): Promise<string[] | undefined> =>
    (
      await api('GET', '/users', {
        query: { customer: 'my_customer', maxResults: 500 },
      })
    )
      .json()
      .users.find((entry: { id: string }) => entry.id === aliased.id)?.aliases;
  assert.ok((await listedAliases())?.includes(aliased.alias));
  await clock.advance(D);
  assert.equal(await listedAliases(), undefined);
});
