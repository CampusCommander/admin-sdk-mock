import assert from 'node:assert/strict';
import test from 'node:test';
import { domainKind } from '../store/addresses.ts';
import { openDomainDb } from '../store/domain-db.ts';
import { outsideMemberId } from '../store/group-lookup.ts';
import { row, rows } from '../store/sqlite.ts';
import { seedDomain } from './seed.ts';
import { resolveSpec } from './spec.ts';

const SEEDED_AT = Date.UTC(2026, 9, 10, 12);

function seeded(input: Record<string, unknown>) {
  const db = openDomainDb(':memory:');
  const spec = resolveSpec(input);
  const result = seedDomain(db, spec, SEEDED_AT);
  const count = (sql: string, ...params: (string | number)[]) =>
    Number(row<{ n: number }>(db.prepare(sql).get(...params))?.n);
  return { db, spec, result, count };
}

const shared = seeded({
  tier: 'medium',
  seed: 'scenarios',
  counts: { schools: 4, students: 2000, staff: 150, devices: 50 },
});

/** Section groups are named `<course> – Period <n> (<teacher>)`. */
const SECTION = "name LIKE '% – Period %' AND name NOT LIKE '%(Unassigned)'";

test('each student in a grade group joins sectionsPerStudent sections of that grade', () => {
  const { db, count } = shared;
  const perStudent = rows<{ n: number }>(
    db
      .prepare(
        `SELECT (SELECT count(*) FROM group_members s JOIN groups sg ON sg.id = s.group_id WHERE s.member_id = m.member_id AND sg.${SECTION} AND s.role = 'MEMBER') AS n
         FROM group_members m JOIN groups g ON g.id = m.group_id
         WHERE g.description LIKE 'Students in %' AND m.type = 'USER'`,
      )
      .all(),
  );
  assert.ok(perStudent.length > 1000);
  assert.ok(perStudent.every((entry) => entry.n >= 1 && entry.n <= 4));
  assert.ok(
    perStudent.filter((entry) => entry.n === 4).length >=
      perStudent.length * 0.95,
  );
  const sizes = rows<{ n: number; owners: number }>(
    db
      .prepare(
        `SELECT sum(m.role = 'MEMBER') AS n, sum(m.role = 'OWNER') AS owners FROM groups g JOIN group_members m ON m.group_id = g.id WHERE g.${SECTION} GROUP BY g.id`,
      )
      .all(),
  );
  const mean =
    sizes.reduce((total, entry) => total + entry.n, 0) / sizes.length;
  assert.ok(mean > 20 && mean <= 30, String(mean));
  assert.ok(sizes.every((entry) => entry.owners === 1));
  assert.equal(
    count(
      `SELECT count(*) AS n FROM group_members m JOIN groups g ON g.id = m.group_id
       WHERE g.${SECTION} AND m.role = 'OWNER' AND m.member_id NOT IN (SELECT id FROM users WHERE role IN ('staff', 'admin'))`,
    ),
    0,
  );
});

test('a section never mixes students of two grade groups', () => {
  const { count } = shared;
  assert.equal(
    count(
      `SELECT count(*) AS n FROM (
         SELECT s.group_id FROM group_members s
           JOIN groups sg ON sg.id = s.group_id AND ${SECTION.replaceAll('name', 'sg.name')}
           JOIN group_members gm ON gm.member_id = s.member_id AND gm.type = 'USER'
           JOIN groups gg ON gg.id = gm.group_id AND gg.description LIKE 'Students in %'
         WHERE s.role = 'MEMBER'
         GROUP BY s.group_id HAVING count(DISTINCT gg.id) > 1)`,
    ),
    0,
  );
});

test('a grade with fewer sections than sectionsPerStudent puts each student in every section', () => {
  const tiny = seeded({
    tier: 'small',
    seed: 'tiny-grades',
    counts: { schools: 1, students: 12, staff: 3, devices: 5 },
  });
  const sections = rows<{ id: string; students: number }>(
    tiny.db
      .prepare(
        `SELECT g.id, sum(m.role = 'MEMBER' AND m.member_id IN (SELECT id FROM users)) AS students FROM groups g JOIN group_members m ON m.group_id = g.id WHERE g.${SECTION} GROUP BY g.id`,
      )
      .all(),
  );
  assert.ok(sections.length > 0);
  for (const section of sections) {
    const grade = tiny.count(
      `SELECT count(*) AS n FROM group_members gm JOIN groups gg ON gg.id = gm.group_id
       WHERE gg.description LIKE 'Students in %' AND gg.id = (
         SELECT gm2.group_id FROM group_members s JOIN group_members gm2 ON gm2.member_id = s.member_id
         JOIN groups g2 ON g2.id = gm2.group_id AND g2.description LIKE 'Students in %'
         WHERE s.group_id = ? AND s.role = 'MEMBER' LIMIT 1)`,
      section.id,
    );
    assert.equal(section.students, grade, section.id);
  }
});

test('sectionsPerStudent 0 seeds no sections', () => {
  const none = seeded({
    tier: 'small',
    seed: 'no-sections',
    counts: { schools: 2, students: 100, staff: 10, devices: 5 },
    rates: { sectionsPerStudent: 0, emptyGroups: 0 },
  });
  assert.equal(
    none.count(
      "SELECT count(*) AS n FROM groups WHERE name LIKE '% – Period %'",
    ),
    0,
  );
});

test('parent groups, the board, and outside guests reach the outside-member share', () => {
  const { db, spec, count } = shared;
  const outside = rows<{
    group_id: string;
    member_id: string;
    email: string;
    type: string;
  }>(
    db
      .prepare(
        "SELECT group_id, member_id, email, type FROM group_members WHERE email != '' AND substr(email, instr(email, '@') + 1) NOT IN (SELECT domain_name FROM domains)",
      )
      .all(),
  );
  for (const member of outside) {
    assert.equal(member.type, 'USER');
    assert.equal(member.member_id, outsideMemberId(member.email));
    assert.equal(domainKind(db, member.email), 'outside');
  }
  const total = count('SELECT count(*) AS n FROM groups');
  const withOutside = new Set(outside.map((member) => member.group_id)).size;
  assert.equal(withOutside, Math.max(5, Math.round(total * 0.03)));
  const parents = rows<{ id: string }>(
    db.prepare("SELECT id FROM groups WHERE email LIKE '%-parents@%'").all(),
  );
  assert.equal(parents.length, 4);
  for (const { id } of parents) {
    const n = outside.filter((member) => member.group_id === id).length;
    assert.ok(n >= 3 && n <= 12, String(n));
  }
  const board = rows<{ role: string; email: string }>(
    db
      .prepare(
        'SELECT m.role, m.email FROM group_members m JOIN groups g ON g.id = m.group_id WHERE g.email = ?',
      )
      .all(`board@${spec.primaryDomain}`),
  );
  assert.deepEqual(
    board.filter((m) => m.role === 'OWNER').map((m) => m.email),
    [`admin@${spec.primaryDomain}`],
  );
  assert.ok(board.length - 1 >= 5 && board.length - 1 <= 9);
  assert.equal(
    count("SELECT count(*) AS n FROM group_members WHERE type = 'EXTERNAL'"),
    0,
  );
});

test('empty sections make up the emptyGroups share', () => {
  const { count } = shared;
  const total = count('SELECT count(*) AS n FROM groups');
  const unassigned = count(
    "SELECT count(*) AS n FROM groups WHERE name LIKE '%(Unassigned)'",
  );
  assert.equal(unassigned, Math.round(((total - unassigned) * 0.02) / 0.98));
  assert.equal(
    count(
      "SELECT count(*) AS n FROM groups g WHERE g.name LIKE '%(Unassigned)' AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id)",
    ),
    0,
  );
});

test('aliases cover the groupAliases share on the primary domain', () => {
  const { db, spec, count } = shared;
  const total = count('SELECT count(*) AS n FROM groups');
  const aliases = rows<{ alias: string; group_id: string }>(
    db.prepare('SELECT alias, group_id FROM group_aliases').all(),
  );
  assert.equal(aliases.length, Math.round(total * 0.1));
  assert.equal(
    new Set(aliases.map((entry) => entry.group_id)).size,
    aliases.length,
  );
  for (const { alias } of aliases)
    assert.ok(alias.endsWith(`@${spec.primaryDomain}`), alias);
  assert.equal(
    count(
      'SELECT count(*) AS n FROM group_aliases a WHERE a.alias IN (SELECT email FROM groups UNION ALL SELECT primary_email FROM users UNION ALL SELECT alias FROM user_aliases)',
    ),
    0,
  );
});

test('each deep chain nests 8 to 10 groups and ends in 3 staff members', () => {
  for (const chains of [0, 1, 3]) {
    const domain = seeded({
      tier: 'small',
      seed: `chains-${chains}`,
      counts: { schools: 1, students: 60, staff: 10, devices: 5 },
      rates: { deepGroupChains: chains },
    });
    const tops = rows<{ id: string }>(
      domain.db
        .prepare(
          "SELECT id FROM groups WHERE email LIKE 'committee-%-level-1@%'",
        )
        .all(),
    );
    assert.equal(tops.length, chains);
    for (const { id } of tops) {
      const depth = domain.count(
        `WITH RECURSIVE walk(id, depth) AS (
           SELECT ?, 1
           UNION ALL
           SELECT m.member_id, w.depth + 1 FROM walk w JOIN group_members m ON m.group_id = w.id AND m.type = 'GROUP')
         SELECT max(depth) AS n FROM walk`,
        id,
      );
      assert.ok(depth >= 8 && depth <= 10, String(depth));
      const bottom = domain.count(
        `WITH RECURSIVE walk(id, depth) AS (
           SELECT ?, 1
           UNION ALL
           SELECT m.member_id, w.depth + 1 FROM walk w JOIN group_members m ON m.group_id = w.id AND m.type = 'GROUP')
         SELECT count(*) AS n FROM group_members WHERE type = 'USER' AND group_id = (SELECT id FROM walk ORDER BY depth DESC LIMIT 1)`,
        id,
      );
      assert.equal(bottom, 3);
    }
  }
});

test('tier sizes stay near the spec estimates', () => {
  const small = seeded({ tier: 'small', seed: 'size' });
  assert.ok(
    small.result.counts.groups >= 90 && small.result.counts.groups <= 140,
    String(small.result.counts.groups),
  );
  assert.ok(
    small.result.counts.memberships >= 2_000 &&
      small.result.counts.memberships <= 3_300,
    String(small.result.counts.memberships),
  );
  const medium = seeded({ tier: 'medium', seed: 'size' });
  assert.ok(
    medium.result.counts.groups >= 900 && medium.result.counts.groups <= 1_400,
    String(medium.result.counts.groups),
  );
  assert.ok(
    medium.result.counts.memberships >= 26_000 &&
      medium.result.counts.memberships <= 38_000,
    String(medium.result.counts.memberships),
  );
});
