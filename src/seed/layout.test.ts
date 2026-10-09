import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLayout,
  DEVICE_CATEGORIES,
  MAX_DEPTH,
  MAX_UNITS,
  type Layout,
} from './layout.ts';
import { resolveSpec } from './spec.ts';

const within = (ancestor: string, path: string) =>
  path === ancestor || path.startsWith(`${ancestor}/`);

function assertSeparated(layout: Layout) {
  const users = layout.units.filter((unit) => unit.kind === 'users');
  const devices = layout.units.filter((unit) => unit.kind === 'devices');
  assert.ok(users.length > 0 && devices.length > 0);
  for (const user of users)
    for (const device of devices) {
      assert.ok(
        !within(user.path, device.path),
        `${device.path} in ${user.path}`,
      );
      assert.ok(
        !within(device.path, user.path),
        `${user.path} in ${device.path}`,
      );
    }
}

function assertWellFormed(layout: Layout) {
  const byId = new Map(
    [layout.root, ...layout.units].map((unit) => [unit.orgUnitId, unit]),
  );
  const paths = new Set<string>();
  assert.equal(byId.size, layout.units.length + 1, 'IDs are unique.');
  for (const unit of layout.units) {
    assert.ok(!paths.has(unit.path), `duplicate path ${unit.path}`);
    paths.add(unit.path);
    const parent = byId.get(unit.parentId ?? '');
    assert.ok(parent, `parent of ${unit.path}`);
    assert.equal(unit.parentPath, parent.path);
    assert.equal(unit.depth, parent.depth + 1);
    assert.match(unit.orgUnitId, /^id:0[0-9a-z]{13}$/);
  }
}

test('a role-first layout puts students, staff, and devices under separate roots', () => {
  const layout = buildLayout(
    resolveSpec({
      tier: 'medium',
      seed: 'role',
      layout: 'role-first',
      counts: { schools: 6 },
    }),
  );
  assertWellFormed(layout);
  assertSeparated(layout);
  const topLevel = layout.units.filter((unit) => unit.depth === 1);
  assert.equal(topLevel.length, 3);
  for (const school of layout.schools) {
    for (const grade of school.grades)
      assert.ok(school.studentOus[grade], `${school.name} grade ${grade}`);
    for (const category of DEVICE_CATEGORIES)
      assert.ok(school.deviceOus[category]);
    assert.ok(school.staffOu);
  }
});

test('a school-first layout nests students, staff, and devices under each school', () => {
  const layout = buildLayout(
    resolveSpec({
      tier: 'medium',
      seed: 'school',
      layout: 'school-first',
      counts: { schools: 6 },
    }),
  );
  assertWellFormed(layout);
  assertSeparated(layout);
  for (const school of layout.schools) {
    const schoolPath = `/${school.name}`;
    assert.ok(within(schoolPath, school.staffOu));
    assert.ok(within(schoolPath, school.deviceOus.cart));
  }
});

test('the same specification always builds the same layout', () => {
  const spec = resolveSpec({ tier: 'medium', seed: 'repeat' });
  assert.deepEqual(buildLayout(spec), buildLayout(spec));
});

test('labels vary across seeds', () => {
  const labels = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const layout = buildLayout(
      resolveSpec({ tier: 'small', seed: `vary-${i}`, layout: 'role-first' }),
    );
    for (const unit of layout.units.filter((unit) => unit.depth === 1))
      labels.add(unit.name);
  }
  assert.ok(labels.size >= 5, [...labels].join(', '));
});

test('deep branches reach 8 to 12 levels for both users and devices', () => {
  const layout = buildLayout(
    resolveSpec({ tier: 'small', seed: 'deep', rates: { deepBranches: 3 } }),
  );
  const depths = layout.units.map((unit) => unit.depth);
  assert.ok(Math.max(...depths) >= 8);
  assert.ok(Math.max(...depths) <= 12);
  assert.ok(layout.deepUserOus.length > 0);
  assert.ok(layout.deepDeviceOus.length > 0);
  assertSeparated(layout);
});

test('no deep branches exist when the rate is zero', () => {
  const layout = buildLayout(
    resolveSpec({ tier: 'small', seed: 'flat', rates: { deepBranches: 0 } }),
  );
  assert.deepEqual(layout.deepUserOus, []);
  assert.deepEqual(layout.deepDeviceOus, []);
  assert.ok(Math.max(...layout.units.map((unit) => unit.depth)) <= 5);
});

test('an xlarge layout adds regions and stays inside the Google limits', () => {
  const layout = buildLayout(resolveSpec({ tier: 'xlarge', seed: 'cps' }));
  assert.equal(layout.schools.length, 640);
  assert.ok(layout.schools.every((school) => school.region !== null));
  assert.ok(layout.units.length < MAX_UNITS, `${layout.units.length} units`);
  assert.ok(layout.units.length > 5_000, `${layout.units.length} units`);
  assert.ok(layout.units.every((unit) => unit.depth <= MAX_DEPTH));
});

test('school names are unique', () => {
  const layout = buildLayout(resolveSpec({ tier: 'xlarge', seed: 'names' }));
  const names = new Set(layout.schools.map((school) => school.name));
  assert.equal(names.size, layout.schools.length);
});
