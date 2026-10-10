import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../http/errors.ts';
import { NO_OVERRIDES, type Call, type OpenDomain } from '../http/types.ts';
import { outsideMemberId } from '../store/group-lookup.ts';
import { row } from '../store/sqlite.ts';
import { addTestGroup } from '../testing/groups.ts';
import { seedTestDomain, startHarness } from '../testing/harness.ts';
import {
  groupReadyMs,
  nestingDelayMs,
  resolveMemberTarget,
  visibleGroup,
} from './group-common.ts';

const callFor = (
  domain: OpenDomain,
  overrides = NO_OVERRIDES,
  scale = 1,
): Call =>
  ({
    route: { id: 'test', api: 'directory' },
    domain,
    access: { customerId: domain.customerId },
    overrides,
    now: 0,
    scale,
  }) as unknown as Call;

async function setup(t: import('node:test').TestContext) {
  const harness = await startHarness();
  t.after(() => harness.close());
  const domain = seedTestDomain(harness);
  const group = addTestGroup(domain.db, {
    email: `plumbing@${domain.spec.primaryDomain}`,
  });
  return { domain, group };
}

const statusOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof ApiError) return error.response.status;
    throw error;
  }
  return 0;
};

test('visibleGroup finds groups and answers 404 for unknown and hidden groups', async (t) => {
  const { domain, group } = await setup(t);
  assert.equal(
    visibleGroup(callFor(domain), group.email.toUpperCase()).id,
    group.id,
  );
  assert.equal(
    statusOf(() => visibleGroup(callFor(domain), 'missing@x.test')),
    404,
  );
  const hiding = { ...NO_OVERRIDES, hidden: () => new Set([group.id]) };
  assert.equal(
    statusOf(() => visibleGroup(callFor(domain, hiding), group.email)),
    404,
  );
  try {
    visibleGroup(callFor(domain), 'missing@x.test');
  } catch (error) {
    const body = (error as ApiError).response.body as {
      error: { message: string };
    };
    assert.equal(body.error.message, 'Resource Not Found: groupKey');
  }
});

test('resolveMemberTarget tells users, groups, the customer, and outside addresses apart', async (t) => {
  const { domain, group } = await setup(t);
  const call = callFor(domain);
  const user = row<{ id: string; primary_email: string }>(
    domain.db
      .prepare('SELECT id, primary_email FROM users WHERE is_admin = 0 LIMIT 1')
      .get(),
  )!;
  assert.deepEqual(
    (({ type, id, email }) => ({ type, id, email }))(
      resolveMemberTarget(call, user.primary_email)!,
    ),
    { type: 'USER', id: user.id, email: user.primary_email },
  );
  assert.equal(resolveMemberTarget(call, user.id)?.type, 'USER');
  assert.equal(resolveMemberTarget(call, group.email)?.type, 'GROUP');
  assert.deepEqual(resolveMemberTarget(call, domain.customerId), {
    type: 'CUSTOMER',
    id: domain.customerId,
    email: '',
  });
  assert.deepEqual(resolveMemberTarget(call, 'Parent.One@Home.test'), {
    type: 'OUTSIDE',
    id: outsideMemberId('parent.one@home.test'),
    email: 'parent.one@home.test',
  });
  assert.equal(
    resolveMemberTarget(call, `nobody@${domain.spec.primaryDomain}`),
    undefined,
  );
  assert.equal(resolveMemberTarget(call, '123456'), undefined);
});

test('the group delays divide by the time scale', async (t) => {
  const { domain } = await setup(t);
  assert.equal(nestingDelayMs(callFor(domain)), 600_000);
  assert.equal(groupReadyMs(callFor(domain)), 60_000);
  assert.equal(nestingDelayMs(callFor(domain, NO_OVERRIDES, 10)), 60_000);
  assert.equal(groupReadyMs(callFor(domain, NO_OVERRIDES, 10)), 6_000);
});
