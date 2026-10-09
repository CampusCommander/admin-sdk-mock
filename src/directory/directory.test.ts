import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SCOPES, SCOPES } from '../auth/scopes.ts';
import { buildLayout } from '../seed/layout.ts';
import { row } from '../store/sqlite.ts';
import {
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';

const SPEC = {
  tier: 'small',
  seed: 'directory',
  layout: 'role-first',
  counts: { schools: 2, students: 120, staff: 20, devices: 150 },
};
const BASE = '/admin/directory/v1';

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const token = grantToken(harness, domain, READ_SCOPES);
  const get = (path: string, query?: Record<string, string>, bearer = token) =>
    harness.request({
      host: 'admin.googleapis.com',
      path: `${BASE}${path}`,
      query,
      token: bearer,
    });
  return { harness, domain, token, get, layout: buildLayout(domain.spec) };
}

test('customers.get answers for my_customer and the customer ID only', async (t) => {
  const { domain, get } = await setup(t);
  const mine = await get('/customers/my_customer');
  assert.equal(mine.status, 200);
  assert.equal(mine.json().id, domain.customerId);
  assert.equal(mine.json().customerDomain, domain.spec.primaryDomain);
  assert.equal((await get(`/customers/${domain.customerId}`)).status, 200);
  const other = await get('/customers/C0zzzzzzz');
  assert.equal(other.status, 400);
  assert.equal(other.json().error.errors[0].reason, 'badRequest');
  assert.equal(other.json().error.message, 'Bad Request');
});

test('domains.list nests aliases under their parent', async (t) => {
  const { domain, get } = await setup(t);
  const body = (await get('/customer/my_customer/domains')).json();
  const primary = body.domains.find(
    (entry: { isPrimary: boolean }) => entry.isPrimary,
  );
  assert.equal(primary.domainName, domain.spec.primaryDomain);
  assert.deepEqual(
    primary.domainAliases.map(
      (alias: { domainAliasName: string; parentDomainName: string }) => [
        alias.domainAliasName,
        alias.parentDomainName,
      ],
    ),
    [[domain.spec.aliasDomain, domain.spec.primaryDomain]],
  );
});

test('orgunits.list returns children by default and whole trees on request', async (t) => {
  const { domain, get, layout } = await setup(t);
  const children = (await get('/customer/my_customer/orgunits')).json();
  assert.equal(children.organizationUnits.length, 3);
  const all = (
    await get('/customer/my_customer/orgunits', { type: 'all' })
  ).json();
  assert.equal(all.organizationUnits.length, layout.units.length);
  const withParent = (
    await get(`/customer/${domain.customerId}/orgunits`, {
      type: 'all_including_parent',
    })
  ).json();
  assert.equal(withParent.organizationUnits.length, layout.units.length + 1);
  const root = withParent.organizationUnits[0];
  assert.equal(root.orgUnitPath, '/');
  assert.equal(root.parentOrgUnitId, undefined);
  assert.equal(root.parentOrgUnitPath, undefined);
  assert.ok(
    withParent.organizationUnits
      .slice(1)
      .every((unit: { parentOrgUnitId?: string }) => unit.parentOrgUnitId),
  );
});

test('orgunits.list scopes to an OU path with spaces', async (t) => {
  const { get, layout } = await setup(t);
  const school = layout.schools[0];
  assert.match(school.staffOu, / /, 'School names always contain a space.');
  const response = await get('/customer/my_customer/orgunits', {
    orgUnitPath: school.staffOu.slice(1),
    type: 'allIncludingParent',
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.json().organizationUnits[0].orgUnitPath,
    school.staffOu,
  );
});

test('orgunits.get finds units by encoded path and by ID', async (t) => {
  const { domain, get, layout } = await setup(t);
  const unit = layout.units.find((entry) => entry.path.includes(' '))!;
  const byPath = await get(
    `/customer/my_customer/orgunits/${unit.path.slice(1).split('/').map(encodeURIComponent).join('/')}`,
  );
  assert.equal(byPath.status, 200);
  assert.equal(byPath.json().orgUnitId, unit.orgUnitId);
  const byId = await get(
    `/customer/my_customer/orgunits/${encodeURIComponent(unit.orgUnitId)}`,
  );
  assert.equal(byId.json().orgUnitPath, unit.path);
  const missing = await get('/customer/my_customer/orgunits/Nowhere');
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.errors[0].reason, 'notFound');
  assert.ok(domain);
});

test('a token without the OU scope fails with 403', async (t) => {
  const { harness, domain, get } = await setup(t);
  const customerOnly = grantToken(harness, domain, [SCOPES.customer[1]]);
  const response = await get(
    '/customer/my_customer/orgunits',
    undefined,
    customerOnly,
  );
  assert.equal(response.status, 403);
  assert.equal(
    response.json().error.errors[0].reason,
    'insufficientPermissions',
  );
});

test('fields trims an OU list', async (t) => {
  const { get } = await setup(t);
  const body = (
    await get('/customer/my_customer/orgunits', {
      fields: 'organizationUnits(orgUnitPath)',
    })
  ).json();
  assert.deepEqual(Object.keys(body), ['organizationUnits']);
  assert.deepEqual(Object.keys(body.organizationUnits[0]), ['orgUnitPath']);
});

test('the root row exists in the database', async (t) => {
  const { domain } = await setup(t);
  assert.equal(
    row<{ n: number }>(
      domain.db
        .prepare("SELECT count(*) AS n FROM orgunits WHERE path = '/'")
        .get(),
    )?.n,
    1,
  );
});
