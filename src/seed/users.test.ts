import assert from 'node:assert/strict';
import test from 'node:test';
import { openDomainDb } from '../store/domain-db.ts';
import { row, rows } from '../store/sqlite.ts';
import { hashDatabase } from '../testing/db-hash.ts';
import { buildLayout } from './layout.ts';
import { resolveSpec } from './spec.ts';
import { seedUsers } from './users.ts';

const SEEDED_AT = Date.UTC(2026, 9, 9, 12);

function seed(input: Record<string, unknown>) {
  const spec = resolveSpec(input);
  const layout = buildLayout(spec);
  const db = openDomainDb(':memory:');
  const index = seedUsers({ spec, layout, seededAt: SEEDED_AT, db });
  return { spec, layout, db, index };
}

const INPUT = {
  tier: 'medium',
  seed: 'users',
  counts: { schools: 4, students: 3000, staff: 300 },
};

const count = (db: ReturnType<typeof seed>['db'], sql: string) =>
  Number(row<{ n: number }>(db.prepare(sql).get())?.n);

test('the user count is students plus staff plus three administrators', () => {
  const { db } = seed(INPUT);
  assert.equal(count(db, 'SELECT count(*) AS n FROM users'), 3303);
  assert.equal(
    count(db, "SELECT count(*) AS n FROM users WHERE role = 'student'"),
    3000,
  );
  assert.equal(
    count(db, 'SELECT count(*) AS n FROM users WHERE is_admin = 1'),
    3,
  );
});

test('the first administrator is admin at the primary domain', () => {
  const { db, spec, layout, index } = seed(INPUT);
  const admin = row<{ is_admin: number; org_unit_path: string }>(
    db
      .prepare(
        'SELECT is_admin, org_unit_path FROM users WHERE primary_email = ?',
      )
      .get(`admin@${spec.primaryDomain}`),
  );
  assert.equal(admin?.is_admin, 1);
  assert.equal(admin?.org_unit_path, layout.districtStaffOu);
  assert.equal(index.adminEmail, `admin@${spec.primaryDomain}`);
});

test('students use the student domain and staff use the primary domain', () => {
  const { db, spec } = seed(INPUT);
  const students = rows<{ primary_email: string }>(
    db.prepare("SELECT primary_email FROM users WHERE role = 'student'").all(),
  );
  assert.ok(
    students.every((user) =>
      user.primary_email.endsWith(`@${spec.studentDomain}`),
    ),
  );
  const staff = rows<{ primary_email: string }>(
    db.prepare("SELECT primary_email FROM users WHERE role != 'student'").all(),
  );
  assert.ok(
    staff.every((user) =>
      user.primary_email.endsWith(`@${spec.primaryDomain}`),
    ),
  );
});

test('every user sits in a user OU', () => {
  const { db, layout } = seed(INPUT);
  const userOus = new Set(
    layout.units
      .filter((unit) => unit.kind === 'users')
      .map((unit) => unit.path),
  );
  const paths = rows<{ org_unit_path: string }>(
    db.prepare('SELECT DISTINCT org_unit_path FROM users').all(),
  );
  for (const { org_unit_path } of paths)
    assert.ok(userOus.has(org_unit_path), org_unit_path);
});

test('the suspended share follows the rate', () => {
  const { db } = seed(INPUT);
  const share =
    count(db, 'SELECT count(*) AS n FROM users WHERE suspended = 1') / 3303;
  assert.ok(Math.abs(share - 0.04) < 0.02, `share ${share}`);
});

test('aliases point at users and never collide with primary addresses', () => {
  const { db } = seed(INPUT);
  assert.ok(count(db, 'SELECT count(*) AS n FROM user_aliases') > 0);
  assert.equal(
    count(
      db,
      'SELECT count(*) AS n FROM user_aliases a JOIN users u ON u.primary_email = a.alias',
    ),
    0,
  );
  assert.equal(
    count(
      db,
      'SELECT count(*) AS n FROM user_aliases a LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NULL',
    ),
    0,
  );
});

test('external IDs and user IDs are unique', () => {
  const { db } = seed(INPUT);
  assert.equal(
    count(
      db,
      'SELECT count(DISTINCT external_id) AS n FROM users WHERE external_id IS NOT NULL',
    ),
    count(db, 'SELECT count(*) AS n FROM users WHERE external_id IS NOT NULL'),
  );
  const ids = rows<{ id: string }>(db.prepare('SELECT id FROM users').all());
  assert.ok(ids.every(({ id }) => /^1\d{20}$/.test(id)));
});

test('the index lists students and staff per school', () => {
  const { index, layout } = seed(INPUT);
  assert.equal(index.students.length, layout.schools.length);
  assert.ok(index.students.every((list) => list.length > 0));
  assert.ok(index.staff.every((list) => list.length > 0));
  assert.ok(index.districtStaff.length > 0);
});

test('the same specification produces identical users', () => {
  assert.equal(hashDatabase(seed(INPUT).db), hashDatabase(seed(INPUT).db));
  assert.notEqual(
    hashDatabase(seed(INPUT).db),
    hashDatabase(seed({ ...INPUT, seed: 'other' }).db),
  );
});

test('student address styles vary across domains', () => {
  const styles = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const { db } = seed({
      tier: 'small',
      seed: `style-${i}`,
      counts: { students: 20, staff: 5 },
    });
    const local = row<{ primary_email: string }>(
      db
        .prepare(
          "SELECT primary_email FROM users WHERE role = 'student' LIMIT 1",
        )
        .get(),
    )!.primary_email.split('@')[0];
    styles.add(
      /^\d+$/.test(local) ? 'id' : local.includes('.') ? 'dotted' : 'initial',
    );
  }
  assert.ok(styles.size >= 2, [...styles].join(', '));
});

test('no user signs in before the account exists', () => {
  const { db } = seed(INPUT);
  assert.equal(
    count(
      db,
      'SELECT count(*) AS n FROM users WHERE last_login_time < creation_time',
    ),
    0,
  );
});
