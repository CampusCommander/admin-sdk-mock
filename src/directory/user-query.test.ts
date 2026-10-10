import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryError } from './device-query.ts';
import { parseUserQuery } from './user-query.ts';

test('clauses become SQL with parameters', () => {
  const filter = parseUserQuery(
    "givenName:Jane familyName:Smi* isSuspended=true orgUnitPath='/Staff/Lincoln Elementary'",
  );
  assert.deepEqual(filter.where, [
    'cc_contains_words(given_name, ?)',
    'cc_word_prefix(family_name, ?)',
    'suspended = ?',
    '(org_unit_path = ? OR (org_unit_path >= ? AND org_unit_path < ?))',
  ]);
  assert.deepEqual(filter.params, [
    'Jane',
    'Smi',
    1,
    '/Staff/Lincoln Elementary',
    '/Staff/Lincoln Elementary/',
    '/Staff/Lincoln Elementary0',
  ]);
});

test('quoted values unescape apostrophes', () => {
  assert.deepEqual(parseUserQuery("name:'Ann O\\'Hara'").params, [
    "Ann O'Hara",
  ]);
});

test('the root OU and a bare term need no OU clause', () => {
  assert.deepEqual(parseUserQuery("orgUnitPath='/'").where, []);
  const free = parseUserQuery('jane');
  assert.equal(free.where.length, 1);
  assert.deepEqual(free.params, ['jane', 'jane', 'jane']);
});

test('unsupported fields and bad booleans fail', () => {
  for (const text of [
    'robot=1',
    'isAdmin=maybe',
    'isAdmin:true',
    'orgUnitPath:/x',
  ])
    assert.throws(() => parseUserQuery(text), QueryError, text);
});
