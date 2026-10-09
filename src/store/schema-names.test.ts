import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSchemaNames } from '../../scripts/schema-names.ts';
import { SCHEMA_NAMES } from './schema-names.ts';

test('the committed schema names match the discovery documents', () => {
  assert.deepEqual([...SCHEMA_NAMES], collectSchemaNames().names);
});
