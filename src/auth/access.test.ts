import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiRequest, ApiResponse, Route } from '../http/types.ts';
import { row } from '../store/sqlite.ts';
import {
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { SCOPES } from './scopes.ts';

const route = (api: 'directory' | 'chrome', admin = true): Route => ({
  id: `${api}.test`,
  api,
  hosts: ['admin.googleapis.com'],
  methods: ['GET'],
  pattern: /^\/x$/,
  scopes: SCOPES.orgunit,
  admin,
  handler: () => ({ status: 200 }),
});

const request = (token?: string): ApiRequest => ({
  method: 'GET',
  host: 'admin.googleapis.com',
  path: '/x',
  query: new URLSearchParams(),
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: '',
});

const failure = (value: unknown) =>
  value as ApiResponse & {
    body: {
      error: Record<string, unknown> & { errors?: { reason: string }[] };
    };
  };

test('the authenticator accepts a valid administrator token', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, [SCOPES.orgunit[1]]);
  const result = harness.mock.authenticator.authenticate(
    request(token),
    route('directory'),
  );
  assert.ok('access' in result);
  assert.equal(result.access.isAdmin, true);
  assert.equal(result.domain.customerId, domain.customerId);
});

test('missing, unknown, and expired tokens fail with 401', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const auth = harness.mock.authenticator;
  const missing = failure(auth.authenticate(request(), route('directory')));
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.errors?.[0].reason, 'required');
  const unknown = failure(
    auth.authenticate(request('ya29.nope'), route('directory')),
  );
  assert.equal(unknown.body.error.errors?.[0].reason, 'authError');
  harness.mock.registry.saveToken({
    token: 'ya29.old',
    clientId: '1',
    projectId: 'p',
    subject: `admin@${domain.spec.primaryDomain}`,
    customerId: domain.customerId,
    scopes: [SCOPES.orgunit[1]],
    expiresAt: harness.mock.clock.now() - 1,
  });
  assert.equal(
    failure(auth.authenticate(request('ya29.old'), route('directory'))).status,
    401,
  );
  const chrome = failure(auth.authenticate(request(), route('chrome')));
  assert.equal(chrome.body.error.status, 'UNAUTHENTICATED');
});

test('a token for a deleted domain fails with 401', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, [SCOPES.orgunit[1]]);
  harness.mock.domains.delete(domain.customerId);
  assert.equal(
    failure(
      harness.mock.authenticator.authenticate(
        request(token),
        route('directory'),
      ),
    ).status,
    401,
  );
});

test('a token without an accepted scope fails with 403', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, [SCOPES.device[1]]);
  const result = failure(
    harness.mock.authenticator.authenticate(request(token), route('directory')),
  );
  assert.equal(result.status, 403);
  assert.equal(result.body.error.errors?.[0].reason, 'insufficientPermissions');
  const chrome = failure(
    harness.mock.authenticator.authenticate(request(token), route('chrome')),
  );
  assert.equal(chrome.body.error.status, 'PERMISSION_DENIED');
});

test('a subject that is not an administrator fails only on administrator routes', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const staff = row<{ primary_email: string }>(
    domain.db
      .prepare('SELECT primary_email FROM users WHERE is_admin = 0 LIMIT 1')
      .get(),
  )!.primary_email;
  const token = grantToken(harness, domain, [SCOPES.orgunit[1]], staff);
  const denied = failure(
    harness.mock.authenticator.authenticate(request(token), route('directory')),
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.errors?.[0].reason, 'forbidden');
  const allowed = harness.mock.authenticator.authenticate(
    request(token),
    route('directory', false),
  );
  assert.ok('access' in allowed);
  assert.equal(allowed.access.isAdmin, false);
});

test('the overrides can demote an administrator', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const token = grantToken(harness, domain, [SCOPES.orgunit[1]]);
  harness.mock.overrides = { ...harness.mock.overrides, isAdmin: () => false };
  assert.equal(
    failure(
      harness.mock.authenticator.authenticate(
        request(token),
        route('directory'),
      ),
    ).status,
    403,
  );
});
