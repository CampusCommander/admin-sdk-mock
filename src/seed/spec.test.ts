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

test('the group rates have their spec defaults and ranges', () => {
  const spec = resolveSpec({ tier: 'small', seed: 'rates' });
  assert.equal(spec.rates.sectionsPerStudent, 4);
  assert.equal(spec.rates.externalMemberGroups, 0.03);
  assert.equal(spec.rates.emptyGroups, 0.02);
  assert.equal(spec.rates.groupAliases, 0.1);
  assert.equal(spec.rates.deepGroupChains, 1);
  const custom = resolveSpec({
    tier: 'small',
    seed: 'rates',
    rates: {
      sectionsPerStudent: 0,
      externalMemberGroups: 1,
      emptyGroups: 0.5,
      groupAliases: 0,
      deepGroupChains: 10,
    },
  });
  assert.equal(custom.rates.sectionsPerStudent, 0);
  assert.equal(custom.rates.deepGroupChains, 10);
  for (const rates of [
    { sectionsPerStudent: 11 },
    { sectionsPerStudent: 2.5 },
    { emptyGroups: 0.6 },
    { externalMemberGroups: 1.5 },
    { groupAliases: -0.1 },
    { deepGroupChains: 11 },
    { deepGroupChains: 1.5 },
  ])
    assert.throws(
      () => resolveSpec({ tier: 'small', seed: 'rates', rates }),
      SpecError,
      JSON.stringify(rates),
    );
});

test('the group rates do not change any derived identity value', () => {
  const plain = resolveSpec({ tier: 'small', seed: 'identity' });
  const tuned = resolveSpec({
    tier: 'small',
    seed: 'identity',
    rates: { sectionsPerStudent: 2 },
  });
  assert.equal(tuned.customerId, plain.customerId);
  assert.equal(tuned.primaryDomain, plain.primaryDomain);
  assert.equal(tuned.studentDomain, plain.studentDomain);
});

test('primaryDomain takes a lowercase DNS name of two or more labels', () => {
  const long = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  assert.equal(long.length, 253);
  for (const domain of [
    'example.com',
    'students.example.com',
    'a-b.example.com',
    '0.example.org',
    'x.example-district.test',
    `${'a'.repeat(63)}.example.com`,
    long,
  ])
    assert.equal(
      resolveSpec({ tier: 'small', seed: 'domain', primaryDomain: domain })
        .primaryDomain,
      domain,
      domain,
    );
  for (const bad of [
    '',
    'example',
    'Example.com',
    '-example.com',
    'example-.com',
    'example..com',
    '.example.com',
    'example.com.',
    'exa_mple.com',
    'example .com',
    'example.com/path',
    'éxample.com',
    `${'a'.repeat(64)}.example.com`,
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`,
    5,
    null,
    {},
    ['example.com'],
  ])
    assert.throws(
      () => resolveSpec({ tier: 'small', seed: 'domain', primaryDomain: bad }),
      (error: unknown) =>
        error instanceof SpecError &&
        error.message.startsWith('primaryDomain '),
      JSON.stringify(bad),
    );
});

test('primaryDomain replaces the derived domains and keeps everything else', () => {
  const base = resolveSpec({ tier: 'small', seed: 'derived' });
  const over = resolveSpec({
    tier: 'small',
    seed: 'derived',
    primaryDomain: 'easton-consulting.com',
  });
  assert.equal(over.primaryDomain, 'easton-consulting.com');
  assert.equal(over.aliasDomain, 'k12.easton-consulting.com');
  assert.ok(
    [over.primaryDomain, 'students.easton-consulting.com'].includes(
      over.studentDomain,
    ),
  );
  // The seed decides the separate student domain exactly as it does without the field.
  assert.equal(
    over.studentDomain === over.primaryDomain,
    base.studentDomain === base.primaryDomain,
  );
  assert.equal(over.customerId, base.customerId);
  assert.equal(over.districtName, base.districtName);
  assert.equal(over.slug, base.slug);
  assert.equal(over.layout, base.layout);
  assert.deepEqual(over.counts, base.counts);
  assert.deepEqual(over.rates, base.rates);
});

test('a name and a primaryDomain are independent', () => {
  const spec = resolveSpec({
    tier: 'empty',
    seed: 'named',
    name: 'Lakeview School District',
    primaryDomain: 'lakeview.example.org',
  });
  assert.equal(spec.districtName, 'Lakeview School District');
  assert.equal(spec.slug, 'lakeview-school-district');
  assert.equal(spec.primaryDomain, 'lakeview.example.org');
  assert.equal(spec.studentDomain, 'students.lakeview.example.org');
  assert.equal(spec.aliasDomain, 'k12.lakeview.example.org');
});

test('the empty tier has zero counts and refuses counts and rates', () => {
  const spec = resolveSpec({ tier: 'empty', seed: 'blank' });
  assert.deepEqual(spec.counts, {
    schools: 0,
    students: 0,
    staff: 0,
    devices: 0,
  });
  for (const extra of [
    { counts: { students: 5 } },
    { rates: { suspended: 0.1 } },
  ])
    assert.throws(
      () => resolveSpec({ tier: 'empty', seed: 'blank', ...extra }),
      (error: unknown) =>
        error instanceof SpecError &&
        error.message === 'The empty tier takes no counts or rates.',
    );
});
