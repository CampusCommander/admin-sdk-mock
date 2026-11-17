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

test('a custom field name builds a value subquery', () => {
  const searchable = () => ({ indexed: 1 });
  const equals = parseUserQuery(
    'StudentInfo.StudentID=S100',
    'user_aliases',
    searchable,
  );
  assert.deepEqual(equals.where, [
    'id IN (SELECT user_id FROM user_custom_values WHERE schema_name = ? AND field_name = ? AND lower(search_text) = lower(?))',
  ]);
  assert.deepEqual(equals.params, ['StudentInfo', 'StudentID', 'S100']);
  const prefix = parseUserQuery(
    'StudentInfo.StudentID:S10*',
    'user_aliases',
    searchable,
  );
  assert.match(prefix.where[0], /cc_word_prefix\(search_text, \?\)/);
  assert.deepEqual(prefix.params, ['StudentInfo', 'StudentID', 'S10']);
  const contains = parseUserQuery(
    'StudentInfo.Programs:Band',
    'user_aliases',
    searchable,
  );
  assert.match(contains.where[0], /cc_contains_words\(search_text, \?\)/);
  assert.deepEqual(contains.params, ['StudentInfo', 'Programs', 'Band']);
});

test('an unknown or unsearchable custom field fails', () => {
  assert.throws(
    () =>
      parseUserQuery('StudentInfo.Missing=1', 'user_aliases', () => undefined),
    QueryError,
  );
  assert.throws(
    () =>
      parseUserQuery('StudentInfo.StudentID=1', 'user_aliases', () => ({
        indexed: 0,
      })),
    QueryError,
  );
  assert.throws(
    () =>
      parseUserQuery('StudentInfo=1', 'user_aliases', () => ({ indexed: 1 })),
    QueryError,
  );
});

test('a multi-valued custom field matches one entry at a time', () => {
  const multi = () => ({ indexed: 1, multiValued: true });
  const equals = parseUserQuery(
    'StudentInfo.Programs=Band',
    'user_aliases',
    multi,
  );
  assert.equal(equals.where.length, 1);
  assert.match(equals.where[0], /json_valid\(search_text\)/);
  assert.match(equals.where[0], /json_each\(search_text\)/);
  assert.match(equals.where[0], /lower\(entry\.value\) = lower\(\?\)/);
  assert.deepEqual(equals.params, ['StudentInfo', 'Programs', 'Band']);
  const prefix = parseUserQuery(
    'StudentInfo.Programs:B*',
    'user_aliases',
    multi,
  );
  assert.match(prefix.where[0], /cc_word_prefix\(entry\.value, \?\)/);
  assert.deepEqual(prefix.params, ['StudentInfo', 'Programs', 'B']);
  const phrase = parseUserQuery(
    "StudentInfo.Programs:'Band ELL'",
    'user_aliases',
    multi,
  );
  assert.match(phrase.where[0], /cc_contains_words\(entry\.value, \?\)/);
  assert.deepEqual(phrase.params, ['StudentInfo', 'Programs', 'Band ELL']);
});

test('a schema name may start with a digit, an underscore, or a hyphen', () => {
  for (const name of ['_Info', '1Info', '-Info']) {
    const parsed = parseUserQuery(`${name}.Code=S100`, 'user_aliases', () => ({
      indexed: 1,
    }));
    assert.equal(parsed.where.length, 1, name);
    assert.deepEqual(parsed.params, [name, 'Code', 'S100'], name);
  }
  // A bare term still takes the free-text branch.
  const free = parseUserQuery('2026');
  assert.deepEqual(free.params, ['2026', '2026', '2026']);
});
