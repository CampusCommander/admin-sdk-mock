import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareObservations,
  errorSignature,
  missingPaths,
  redact,
  shapeOf,
} from './compare.ts';

test('shapes merge array elements and record types', () => {
  assert.deepEqual(shapeOf({ a: 1, b: [{ x: 's' }, { y: true }], c: null }), {
    a: 'number',
    b: [{ x: 'string', y: 'boolean' }],
    c: 'null',
  });
});

test('missingPaths lists what the mock lacks', () => {
  assert.deepEqual(
    missingPaths(
      shapeOf({ a: 1, b: { c: 1, d: 2 } }),
      shapeOf({ a: 1, b: { c: 1 }, e: 3 }),
    ),
    ['$.b.d'],
  );
});

test('error signatures cover both envelopes and OAuth errors', () => {
  assert.deepEqual(
    errorSignature({
      error: {
        code: 403,
        message: 'm',
        status: 'S',
        errors: [{ reason: 'r', domain: 'global', message: 'n' }],
      },
    }),
    {
      code: 403,
      message: 'm',
      status: 'S',
      reason: 'r',
      domain: 'global',
      itemMessage: 'n',
      keys: 'code,errors,message,status',
    },
  );
  assert.deepEqual(
    errorSignature({ error: 'unauthorized_client', error_description: 'x' }),
    {
      error: 'unauthorized_client',
      description: 'x',
    },
  );
});

test('redaction replaces identifiers inside strings', () => {
  assert.deepEqual(
    redact({ m: 'Customer C01abcdef owns a@b.test at b.test' }, [/b\.test/g]),
    { m: 'Customer <customer> owns <email> at <redacted>' },
  );
});

test('a success comparison flags missing fields and notes extras', () => {
  const result = compareObservations(
    'p',
    { status: 200, body: { a: 1, b: 2 } },
    { status: 200, body: { a: 1, c: 3 } },
  );
  assert.deepEqual(result.mismatches, ['missing $.b']);
  assert.deepEqual(result.notes, ['extra $.c']);
});

test('an error comparison flags every differing signature field', () => {
  const result = compareObservations(
    'p',
    {
      status: 403,
      body: {
        error: {
          code: 403,
          message: 'x',
          errors: [{ reason: 'forbidden', domain: 'global', message: 'x' }],
        },
      },
    },
    {
      status: 404,
      body: {
        error: {
          code: 404,
          message: 'y',
          errors: [{ reason: 'notFound', domain: 'global', message: 'y' }],
        },
      },
    },
  );
  assert.deepEqual(result.mismatches, [
    'status 403 != 404',
    'code 403 != 404',
    'message "x" != "y"',
    'reason "forbidden" != "notFound"',
    'itemMessage "x" != "y"',
  ]);
});
