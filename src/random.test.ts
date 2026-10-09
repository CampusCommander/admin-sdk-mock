import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.ts';

const draws = (seed: string, count = 5) => {
  const random = createRandom(seed);
  return Array.from({ length: count }, () => random.next());
};

test('the same seed produces the same sequence', () => {
  assert.deepEqual(draws('district-1'), draws('district-1'));
});

test('different seeds produce different sequences', () => {
  assert.notDeepEqual(draws('district-1'), draws('district-2'));
});

test('a fork depends on its label, not on the parent position', () => {
  const advanced = createRandom('s');
  advanced.next();
  advanced.next();
  const fresh = createRandom('s');
  assert.equal(advanced.fork('device/1').next(), fresh.fork('device/1').next());
  assert.notEqual(fresh.fork('device/1').next(), fresh.fork('device/2').next());
});

test('int stays inside inclusive bounds and reaches both ends', () => {
  const random = createRandom('bounds');
  const seen = new Set<number>();
  for (let i = 0; i < 1000; i++) seen.add(random.int(1, 3));
  assert.deepEqual([...seen].sort(), [1, 2, 3]);
});

test('chance honors zero and one', () => {
  const random = createRandom('chance');
  for (let i = 0; i < 100; i++) {
    assert.equal(random.chance(0), false);
    assert.equal(random.chance(1), true);
  }
});

test('weighted never returns a zero-weight entry', () => {
  const random = createRandom('weighted');
  for (let i = 0; i < 200; i++)
    assert.equal(
      random.weighted([
        ['a', 0],
        ['b', 1],
      ]),
      'b',
    );
});

test('normal draws center on zero with unit spread', () => {
  const random = createRandom('normal');
  const values = Array.from({ length: 10_000 }, () => random.normal());
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  assert.ok(Math.abs(mean) < 0.05, `mean ${mean}`);
  assert.ok(Math.abs(Math.sqrt(variance) - 1) < 0.05, `sd ${variance}`);
});

test('string and uuid use the requested formats', () => {
  const random = createRandom('format');
  assert.match(random.string(8), /^[0-9a-z]{8}$/);
  assert.match(random.string(4, 'AB'), /^[AB]{4}$/);
  assert.match(
    random.uuid(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('pick rejects an empty list', () => {
  assert.throws(() => createRandom('empty').pick([]), RangeError);
});
