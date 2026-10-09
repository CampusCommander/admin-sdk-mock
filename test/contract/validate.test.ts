import assert from 'node:assert/strict';
import test from 'node:test';
import { methodSchema, validate, type Discovery } from './validate.ts';

const doc: Discovery = {
  schemas: {
    Item: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        size: { type: 'string', format: 'int64' },
        when: { type: 'string', format: 'date-time' },
        state: { type: 'string', enum: ['ON', 'OFF'] },
        tags: { type: 'array', items: { type: 'string' } },
        child: { $ref: 'Item' },
        extra: { type: 'any' },
      },
    },
  },
  resources: { items: { methods: { get: { response: { $ref: 'Item' } } } } },
};

test('a valid value has no errors', () => {
  assert.deepEqual(
    validate(
      doc,
      { $ref: 'Item' },
      {
        id: 'a',
        size: '12',
        when: '2026-10-09T00:00:00Z',
        state: 'ON',
        tags: ['x'],
        child: { id: 'b' },
        extra: { anything: [1] },
      },
    ),
    [],
  );
});

test('each violation names its path', () => {
  assert.deepEqual(
    validate(
      doc,
      { $ref: 'Item' },
      {
        id: 1,
        size: '1.5',
        when: 'later',
        state: 'MAYBE',
        tags: [2],
        child: { bogus: true },
        invented: true,
      },
    ),
    [
      '$.id: expected string',
      '$.size: expected an integer string',
      '$.when: expected a date-time',
      '$.state: MAYBE is not in the enum',
      '$.tags[0]: expected string',
      '$.child.bogus: not in schema',
      '$.invented: not in schema',
    ],
  );
});

test('methodSchema walks nested resources', () => {
  assert.deepEqual(methodSchema(doc, ['items', 'get']), { $ref: 'Item' });
  assert.throws(() => methodSchema(doc, ['items', 'list']));
});
