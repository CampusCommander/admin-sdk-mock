import assert from 'node:assert/strict';
import test from 'node:test';
import { containsWords, hasWordPrefix } from './text.ts';

test('containsWords matches whole words in order', () => {
  assert.equal(containsWords('Jane Ann', 'Jane'), true);
  assert.equal(containsWords('Janet', 'Jane'), false);
  assert.equal(containsWords('Mary Jane Ann', 'jane ann'), true);
  assert.equal(containsWords('Ann Jane', 'jane ann'), false);
  assert.equal(containsWords(null, 'x'), false);
  assert.equal(containsWords('a.b@c.test', 'b'), true);
});

test('hasWordPrefix matches the start of any word', () => {
  assert.equal(hasWordPrefix('Janet', 'Jane'), true);
  assert.equal(hasWordPrefix('Mary Janet', 'jan'), true);
  assert.equal(hasWordPrefix('Mary', 'jan'), false);
  assert.equal(hasWordPrefix(null, 'x'), false);
});
