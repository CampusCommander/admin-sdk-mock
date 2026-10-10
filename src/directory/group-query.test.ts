import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryError } from './device-query.ts';
import { parseGroupQuery } from './group-query.ts';

test('email and name accept = and :prefix*', () => {
  assert.deepEqual(parseGroupQuery("email=Staff@Lake.test name:'Art C'*"), {
    filter: {
      where: ['email = lower(?)', "lower(name) LIKE ? ESCAPE '\\'"],
      params: ['Staff@Lake.test', 'art c%'],
    },
    memberKey: null,
  });
  assert.deepEqual(parseGroupQuery("name='Valentine\\'s Day'").filter.params, [
    "Valentine's Day",
  ]);
  assert.deepEqual(parseGroupQuery('email:a_b*').filter.params, ['a\\_b%']);
});

test('memberKey stands alone and accepts only =', () => {
  assert.deepEqual(parseGroupQuery('memberKey=ann@lake.test'), {
    filter: { where: [], params: [] },
    memberKey: 'ann@lake.test',
  });
  for (const query of [
    'memberKey=ann@lake.test email=staff@lake.test',
    'name:Art* memberKey=ann@lake.test',
    'memberKey:ann*',
    'name:Art',
    'description=x',
    'staff',
  ])
    assert.throws(() => parseGroupQuery(query), QueryError, query);
});
