import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RATES, resolveSpec, SpecError, TIERS } from './spec.ts';

test('a tier supplies the default counts and rates', () => {
  const spec = resolveSpec({ tier: 'medium', seed: 'm1' });
  assert.deepEqual(spec.counts, TIERS.medium);
  assert.deepEqual(spec.rates, DEFAULT_RATES);
  assert.equal(spec.tier, 'medium');
});

test('overrides replace individual counts and rates', () => {
  const spec = resolveSpec({
    tier: 'small',
    seed: 'o1',
    counts: { devices: 50 },
    rates: { disabled: 0.5, deepBranches: 0 },
  });
  assert.equal(spec.counts.devices, 50);
  assert.equal(spec.counts.students, TIERS.small.students);
  assert.equal(spec.rates.disabled, 0.5);
  assert.equal(spec.rates.deepBranches, 0);
});

test('the same input resolves to the same specification', () => {
  const input = { tier: 'large', seed: 'same' };
  assert.deepEqual(resolveSpec(input), resolveSpec(input));
});

test('identity fields use the documented formats', () => {
  const spec = resolveSpec({ tier: 'small', seed: 'format' });
  assert.match(spec.customerId, /^C0[0-9a-z]{7}$/);
  assert.equal(spec.primaryDomain, `${spec.slug}.test`);
  assert.equal(spec.aliasDomain, `${spec.slug}-k12.test`);
  assert.ok(
    [spec.primaryDomain, `students.${spec.slug}.test`].includes(
      spec.studentDomain,
    ),
  );
  assert.match(spec.slug, /^[a-z0-9-]{1,40}$/);
  assert.ok(['role-first', 'school-first'].includes(spec.layout));
});

test('a name and a layout override the generated values', () => {
  const spec = resolveSpec({
    tier: 'small',
    seed: 'named',
    name: 'Lakeview School District',
    layout: 'school-first',
  });
  assert.equal(spec.districtName, 'Lakeview School District');
  assert.equal(spec.slug, 'lakeview-school-district');
  assert.equal(spec.layout, 'school-first');
});

test('different seeds produce different customers', () => {
  assert.notEqual(
    resolveSpec({ tier: 'small', seed: 'a' }).customerId,
    resolveSpec({ tier: 'small', seed: 'b' }).customerId,
  );
});

test('invalid specifications fail with a message', () => {
  const bad: unknown[] = [
    null,
    { seed: 'x' },
    { tier: 'huge', seed: 'x' },
    { tier: 'small', seed: '' },
    { tier: 'small', seed: 'has space' },
    { tier: 'small', seed: 'x', extra: 1 },
    { tier: 'small', seed: 'x', counts: { devices: 0 } },
    { tier: 'small', seed: 'x', counts: { devices: 1.5 } },
    { tier: 'small', seed: 'x', counts: { robots: 1 } },
    { tier: 'small', seed: 'x', rates: { disabled: 2 } },
    { tier: 'small', seed: 'x', rates: { disabled: 0.6, deprovisioned: 0.6 } },
    { tier: 'small', seed: 'x', rates: { deepBranches: 21 } },
    { tier: 'small', seed: 'x', layout: 'sideways' },
    { tier: 'small', seed: 'x', name: '' },
  ];
  for (const input of bad)
    assert.throws(() => resolveSpec(input), SpecError, JSON.stringify(input));
});
