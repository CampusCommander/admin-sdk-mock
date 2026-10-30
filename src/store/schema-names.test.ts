import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSchemaNames } from '../../scripts/schema-names.ts';
import { SCHEMA_NAMES } from './schema-names.ts';

test('the committed schema names match the discovery documents', () => {
  const { names, added } = collectSchemaNames();
  assert.deepEqual([...SCHEMA_NAMES], [...names, ...added]);
  assert.equal(new Set(SCHEMA_NAMES).size, names.length + added.length);
  for (const name of added) assert.ok(!names.includes(name), name);
});
