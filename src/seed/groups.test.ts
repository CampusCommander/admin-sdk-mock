import assert from 'node:assert/strict';
import test from 'node:test';
import { DELIVERIES, ROLES } from '../store/group-lookup.ts';
import { openDomainDb } from '../store/domain-db.ts';
import { row, rows } from '../store/sqlite.ts';
import { CLUBS } from './courses.ts';
import { groupSlug } from './groups.ts';
import { buildLayout } from './layout.ts';
import { seedDomain } from './seed.ts';
import { resolveSpec } from './spec.ts';

const SEEDED_AT = Date.UTC(2026, 9, 10, 12);

function seeded(input: Record<string, unknown>) {
  const db = openDomainDb(':memory:');
  const spec = resolveSpec(input);
  const result = seedDomain(db, spec, SEEDED_AT);
  return { db, spec, result, layout: buildLayout(spec) };
}

const shared = seeded({
  tier: 'medium',
  seed: 'groups',
  counts: { schools: 4, students: 1200, staff: 120, devices: 50 },
});
const { db, spec, layout } = shared;
const count = (sql: string, ...params: (string | number)[]) =>
  Number(row<{ n: number }>(db.prepare(sql).get(...params))?.n);
const membersOf = (email: string) =>
  rows<{ member_id: string; email: string; type: string; role: string }>(
    db
      .prepare(
        'SELECT m.member_id, m.email, m.type, m.role FROM group_members m JOIN groups g ON g.id = m.group_id WHERE g.email = ? ORDER BY m.email, m.member_id',
      )
      .all(email),
  );
const exists = (email: string) =>
  count('SELECT count(*) AS n FROM groups WHERE email = ?', email) === 1;

test('each school has staff, grade, students, and school-wide groups', () => {
  for (const school of layout.schools) {
    const base = groupSlug(school.name);
    assert.ok(exists(`${base}-staff@${spec.primaryDomain}`), school.name);
    assert.ok(exists(`${base}-students@${spec.studentDomain}`), school.name);
    assert.ok(exists(`${base}-all@${spec.primaryDomain}`), school.name);
    for (const grade of school.grades) {
      const ou = school.studentOus[grade];
      const students = count(
        "SELECT count(*) AS n FROM users WHERE role = 'student' AND (org_unit_path = ? OR org_unit_path LIKE ?)",
        ou,
        `${ou}/%`,
      );
      const email = `${base}-${groupSlug(ou.slice(ou.lastIndexOf('/') + 1))}@${spec.studentDomain}`;
      if (students === 0) continue;
      assert.equal(membersOf(email).length, students, email);
      assert.ok(membersOf(email).every((member) => member.type === 'USER'));
    }
  }
});

test('a school-wide group reaches each of its students through three levels', () => {
  const school = layout.schools[0];
  const base = groupSlug(school.name);
  const reached = count(
    `SELECT count(*) AS n FROM groups top
       JOIN group_members a ON a.group_id = top.id AND a.type = 'GROUP'
       JOIN group_members b ON b.group_id = a.member_id AND b.type = 'GROUP'
       JOIN group_members c ON c.group_id = b.member_id AND c.type = 'USER'
     WHERE top.email = ?`,
    `${base}-all@${spec.primaryDomain}`,
  );
  const grades = school.grades.map((grade) => school.studentOus[grade]);
  const students = grades.reduce(
    (total, ou) =>
      total +
      count(
        "SELECT count(*) AS n FROM users WHERE role = 'student' AND (org_unit_path = ? OR org_unit_path LIKE ?)",
        ou,
        `${ou}/%`,
      ),
    0,
  );
  assert.ok(students > 0);
  assert.equal(reached, students);
});

test('staff groups hold the school staff with one owner and at most two managers', () => {
  for (const school of layout.schools) {
    const members = membersOf(
      `${groupSlug(school.name)}-staff@${spec.primaryDomain}`,
    );
    const staff = count(
      "SELECT count(*) AS n FROM users WHERE role = 'staff' AND school = ?",
      school.index,
    );
    assert.equal(members.length, staff, school.name);
    if (staff === 0) continue;
    assert.equal(members.filter((m) => m.role === 'OWNER').length, 1);
    assert.ok(members.filter((m) => m.role === 'MANAGER').length <= 2);
  }
});

test('district groups hold the district staff, the schools, the customer, the admins, and the principals', () => {
  const primary = spec.primaryDomain;
  const allStaff = membersOf(`all-staff@${primary}`);
  assert.equal(
    allStaff.filter((m) => m.type === 'USER').length,
    count(
      "SELECT count(*) AS n FROM users WHERE role IN ('staff', 'admin') AND school IS NULL",
    ),
  );
  assert.equal(
    allStaff.filter((m) => m.type === 'GROUP').length,
    layout.schools.length,
  );
  assert.equal(
    membersOf(`all-students@${primary}`).filter((m) => m.type === 'GROUP')
      .length,
    layout.schools.length,
  );
  assert.deepEqual(
    membersOf(`everyone@${primary}`).map((m) => ({ ...m })),
    [
      {
        member_id: spec.customerId,
        email: '',
        type: 'CUSTOMER',
        role: 'MEMBER',
      },
    ],
  );
  const tech = membersOf(`tech-team@${primary}`);
  assert.equal(tech.length, 3);
  assert.equal(tech.filter((m) => m.role === 'OWNER').length, 1);
  const owners = rows<{ member_id: string }>(
    db
      .prepare(
        "SELECT m.member_id FROM group_members m JOIN groups g ON g.id = m.group_id WHERE g.email LIKE ? AND g.email != ? AND m.role = 'OWNER' ORDER BY m.member_id",
      )
      .all(`%-staff@${primary}`, `all-staff@${primary}`),
  ).map((entry) => entry.member_id);
  assert.deepEqual(
    membersOf(`principals@${primary}`)
      .map((m) => m.member_id)
      .sort(),
    owners.sort(),
  );
});

test('region staff groups sit between all staff and the school staff groups', () => {
  const regional = seeded({
    tier: 'small',
    seed: 'regions',
    counts: { schools: 200, students: 400, staff: 400, devices: 10 },
  });
  const regionNames = new Set(
    regional.layout.schools.map((school) => school.region),
  );
  assert.ok(regionNames.size >= 2 && !regionNames.has(null));
  const top = rows<{ member_id: string; type: string }>(
    regional.db
      .prepare(
        'SELECT m.member_id, m.type FROM group_members m JOIN groups g ON g.id = m.group_id WHERE g.email = ?',
      )
      .all(`all-staff@${regional.spec.primaryDomain}`),
  ).filter((m) => m.type === 'GROUP');
  assert.equal(top.length, regionNames.size);
  const schoolLinks = Number(
    row<{ n: number }>(
      regional.db
        .prepare(
          `SELECT count(*) AS n FROM group_members m WHERE m.type = 'GROUP' AND m.group_id IN (${top.map(() => '?').join(', ')})`,
        )
        .get(...top.map((m) => m.member_id)),
    )?.n,
  );
  assert.equal(schoolLinks, 200);
});

test('clubs are the only user-created groups', () => {
  const created = rows<{ name: string }>(
    db.prepare('SELECT name FROM groups WHERE admin_created = 0').all(),
  );
  assert.ok(created.length >= layout.schools.length);
  assert.ok(created.length <= layout.schools.length * 3);
  for (const { name } of created)
    assert.ok(
      CLUBS.some((club) => name.endsWith(club)),
      name,
    );
});

test('group addresses are unique, on customer domains, and free of user addresses', () => {
  const groups = rows<{ id: string; email: string }>(
    db.prepare('SELECT id, email FROM groups').all(),
  );
  assert.equal(new Set(groups.map((g) => g.email)).size, groups.length);
  for (const group of groups) {
    assert.match(group.id, /^0[0-9a-z]{14}$/);
    const domain = group.email.slice(group.email.indexOf('@') + 1);
    assert.ok(
      domain === spec.primaryDomain || domain === spec.studentDomain,
      group.email,
    );
  }
  assert.equal(
    count(
      'SELECT count(*) AS n FROM groups g WHERE g.email IN (SELECT primary_email FROM users UNION ALL SELECT alias FROM user_aliases)',
    ),
    0,
  );
});

test('memberships are well formed, timed in the past, and free of cycles', () => {
  const values = (column: string) =>
    rows<{ v: string }>(
      db.prepare(`SELECT DISTINCT ${column} AS v FROM group_members`).all(),
    ).map((entry) => entry.v);
  for (const type of values('type'))
    assert.ok(['USER', 'GROUP', 'CUSTOMER'].includes(type), type);
  for (const role of values('role'))
    assert.ok((ROLES as readonly string[]).includes(role), role);
  for (const delivery of values('delivery'))
    assert.ok(
      (DELIVERIES as readonly string[]).includes(delivery) &&
        delivery !== 'DISABLED',
      delivery,
    );
  assert.equal(
    count(
      "SELECT count(*) AS n FROM group_members m WHERE m.type = 'GROUP' AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = m.member_id AND g.email = m.email)",
    ),
    0,
  );
  assert.equal(
    count(
      "SELECT count(*) AS n FROM group_members m WHERE m.type = 'USER' AND substr(m.email, instr(m.email, '@') + 1) IN (SELECT domain_name FROM domains) AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.member_id AND u.primary_email = m.email)",
    ),
    0,
  );
  assert.equal(
    count(
      'SELECT count(*) AS n FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.added_at < g.created_at OR m.added_at > ?',
      SEEDED_AT - 600_000,
    ),
    0,
  );
  assert.equal(
    count(
      `WITH RECURSIVE walk(root, id, depth) AS (
         SELECT id, id, 0 FROM groups
         UNION ALL
         SELECT w.root, m.member_id, w.depth + 1 FROM walk w
           JOIN group_members m ON m.group_id = w.id AND m.type = 'GROUP'
         WHERE w.depth < 40)
       SELECT count(*) AS n FROM walk WHERE depth > 0 AND id = root`,
    ),
    0,
  );
});

test('delivery settings follow the 85, 7, 4, 4 split', () => {
  const total = count('SELECT count(*) AS n FROM group_members');
  const share = (value: string) =>
    count('SELECT count(*) AS n FROM group_members WHERE delivery = ?', value) /
    total;
  assert.ok(share('ALL_MAIL') > 0.8 && share('ALL_MAIL') < 0.9);
  assert.ok(share('DIGEST') > 0.04 && share('DIGEST') < 0.1);
});

test('the seed result counts groups and memberships', () => {
  assert.equal(
    shared.result.counts.groups,
    count('SELECT count(*) AS n FROM groups'),
  );
  assert.equal(
    shared.result.counts.memberships,
    count('SELECT count(*) AS n FROM group_members'),
  );
  assert.ok(shared.result.counts.groups > 0);
});
