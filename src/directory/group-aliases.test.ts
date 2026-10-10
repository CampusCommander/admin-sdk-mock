import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { row } from '../store/sqlite.ts';
import { addTestGroup } from '../testing/groups.ts';
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
  const group = addTestGroup(domain.db, { email: `staff@${P}` });
  const api = directoryClient(
    harness,
    grantToken(harness, domain, READ_WRITE_SCOPES),
  );
  const aliases = async (key = group.email) => {
    const response = await api('GET', `/groups/${key}/aliases`);
    assert.equal(response.status, 200, response.text);
    return (response.json().aliases ?? []).map(
      (entry: { alias: string }) => entry.alias,
    );
  };
  return { clock, harness, domain, P, group, api, aliases };
}

test('insert adds an alias that works as a group key at once and lists after the delay', async (t) => {
  const { clock, P, group, api, aliases } = await setup(t);
  const inserted = await api('POST', `/groups/${group.email}/aliases`, {
    body: { alias: `Faculty@${P}` },
  });
  assert.equal(inserted.status, 200, inserted.text);
  const body = inserted.json();
  assert.equal(typeof body.etag, 'string');
  delete body.etag;
  assert.deepEqual(body, {
    kind: 'admin#directory#alias',
    id: group.id,
    primaryEmail: group.email,
    alias: `faculty@${P}`,
  });
  assert.equal((await api('GET', `/groups/faculty@${P}`)).json().id, group.id);
  assert.deepEqual(await aliases(), []);
  await clock.advance(D);
  assert.deepEqual(await aliases(), [`faculty@${P}`]);
  const listed = (await api('GET', `/groups/${group.id}/aliases`)).json();
  assert.equal(listed.kind, 'admin#directory#aliases');
  assert.equal(listed.aliases[0].primaryEmail, group.email);
});

test('insert rejects bad, outside, and taken addresses', async (t) => {
  const { domain, P, group, api } = await setup(t);
  const status = async (alias: unknown) =>
    (await api('POST', `/groups/${group.id}/aliases`, { body: { alias } }))
      .status;
  assert.equal(await status(undefined), 400);
  assert.equal(await status('nope'), 400);
  assert.equal(await status('x@elsewhere.test'), 400);
  assert.equal(await status(`x@${domain.spec.aliasDomain}`), 400);
  const user = row<{ primary_email: string }>(
    domain.db.prepare('SELECT primary_email FROM users LIMIT 1').get(),
  )!;
  assert.equal(await status(user.primary_email), 409);
  assert.equal(await status(group.email), 409);
  assert.equal(await status(`fresh@${P}`), 200);
  assert.equal(await status(`fresh@${P}`), 409);
  assert.equal(
    (
      await api('POST', `/groups/missing@${P}/aliases`, {
        body: { alias: `m@${P}` },
      })
    ).status,
    404,
  );
});

test('delete removes an alias the group holds and answers 404 otherwise', async (t) => {
  const { clock, domain, P, group, api, aliases } = await setup(t);
  domain.db
    .prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)')
    .run(`team@${P}`, group.id);
  const other = addTestGroup(domain.db, { email: `other@${P}` });
  domain.db
    .prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)')
    .run(`elsewhere@${P}`, other.id);
  assert.equal(
    (await api('DELETE', `/groups/${group.id}/aliases/elsewhere@${P}`)).status,
    404,
  );
  assert.equal(
    (await api('DELETE', `/groups/${group.id}/aliases/none@${P}`)).status,
    404,
  );
  const deleted = await api('DELETE', `/groups/${group.id}/aliases/TEAM@${P}`);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, '');
  assert.equal((await api('GET', `/groups/team@${P}`)).status, 404);
  assert.deepEqual(await aliases(), [`team@${P}`]);
  await clock.advance(D);
  assert.deepEqual(await aliases(), []);
});
