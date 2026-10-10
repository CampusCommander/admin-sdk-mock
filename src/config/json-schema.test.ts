import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSchema } from './json-schema.ts';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string' },
    port: { type: 'integer', minimum: 0, maximum: 10 },
    mode: { enum: ['a', 'b'] },
    list: { type: 'array', items: { $ref: '#/$defs/item' } },
    either: { anyOf: [{ type: 'null' }, { type: 'boolean' }] },
  },
  $defs: {
    item: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'number' } },
    },
  },
};

test('a valid value has no errors', () => {
  assert.deepEqual(
    validateSchema(schema, {
      name: 'x',
      port: 3,
      mode: 'a',
      list: [{ id: 1 }],
      either: null,
    }),
    [],
  );
});

test('every error names its JSON path', () => {
  assert.deepEqual(
    validateSchema(schema, {
      port: 3.5,
      mode: 'c',
      list: [{ id: 'z', extra: 1 }],
      either: 3,
      unknown: true,
    }),
    [
      'name is required.',
      'port must be an integer.',
      'mode must be one of: a, b.',
      'list[0].id must be a number.',
      'list[0].extra is not an allowed key.',
      'either must match one of the allowed forms.',
      'unknown is not an allowed key.',
    ],
  );
  assert.deepEqual(validateSchema(schema, { name: 'x', port: 11 }), [
    'port must be at most 10.',
  ]);
  assert.deepEqual(validateSchema(schema, 'text'), [
    'The configuration must be an object.',
  ]);
});
