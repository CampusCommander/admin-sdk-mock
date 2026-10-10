import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../http/errors.ts';
import type { Call } from '../http/types.ts';
import { booleanField, jsonBody, stringField } from './common.ts';

const callWith = (body: string) =>
  ({ route: { api: 'directory' }, request: { body } }) as unknown as Call;

const statusOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof ApiError) return error.response.status;
    throw error;
  }
  return 0;
};

test('jsonBody reads an object and treats an empty body as {}', () => {
  assert.deepEqual(jsonBody(callWith('{"a":1}')), { a: 1 });
  assert.deepEqual(jsonBody(callWith('  ')), {});
});

test('jsonBody rejects malformed JSON and non-objects with 400', () => {
  for (const body of ['{', '[1]', '"text"', 'null', '3'])
    assert.equal(
      statusOf(() => jsonBody(callWith(body))),
      400,
      body,
    );
  try {
    jsonBody(callWith('{'));
  } catch (error) {
    const body = (error as ApiError).response.body as {
      error: { errors: { reason: string }[]; status: string };
    };
    assert.equal(body.error.errors[0].reason, 'invalid');
    assert.equal(body.error.status, 'INVALID_ARGUMENT');
  }
});

test('stringField returns undefined, null, or the string and enforces the limit', () => {
  const call = callWith('');
  assert.equal(stringField(call, {}, 'notes'), undefined);
  assert.equal(stringField(call, { notes: null }, 'notes'), null);
  assert.equal(stringField(call, { notes: 'hi' }, 'notes', 2), 'hi');
  assert.equal(
    statusOf(() => stringField(call, { notes: 'hey' }, 'notes', 2)),
    400,
  );
  assert.equal(
    statusOf(() => stringField(call, { notes: 7 }, 'notes')),
    400,
  );
  assert.equal(stringField(call, { notes: '😀😀' }, 'notes', 2), '😀😀');
});

test('booleanField reads true, false, and null as false', () => {
  const call = callWith('');
  assert.equal(booleanField(call, {}, 'suspended'), undefined);
  assert.equal(booleanField(call, { suspended: true }, 'suspended'), true);
  assert.equal(booleanField(call, { suspended: null }, 'suspended'), false);
  assert.equal(
    statusOf(() => booleanField(call, { suspended: 'yes' }, 'suspended')),
    400,
  );
});
