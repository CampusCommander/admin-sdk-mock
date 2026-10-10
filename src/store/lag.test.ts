import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { seedDomain } from '../seed/seed.ts';
import { resolveSpec } from '../seed/spec.ts';
import { openDomainDb } from './domain-db.ts';
import {
  columnsOf,
  flushLag,
  listedRelation,
  listedSelect,
  pendingLag,
  saveBeforeImage,
  saveBeforeImagesWhere,
} from './lag.ts';
import { row, rows } from './sqlite.ts';

const T0 = Date.UTC(2026, 9, 9, 12);
const D = 300_000;

function seeded(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'lag-'));
  const db = openDomainDb(join(dir, 'domain.sqlite'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  seedDomain(
    db,
    resolveSpec({
      tier: 'small',
      seed: 'lag',
      counts: { schools: 1, students: 30, staff: 5, devices: 40 },
    }),
    T0,
  );
  const deviceId = row<{ device_id: string }>(
    db.prepare('SELECT device_id FROM devices ORDER BY ord LIMIT 1').get(),
  )!.device_id;
  const notesIn = (relation: string) =>
    row<{ notes: string | null }>(
      db
        .prepare(`SELECT notes FROM ${relation} WHERE device_id = ?`)
        .get(deviceId),
    )?.notes;
  const setNotes = (notes: string, at: number) => {
    saveBeforeImage(db, 'devices', deviceId, at, D);
    db.prepare('UPDATE devices SET notes = ? WHERE device_id = ?').run(
      notes,
      deviceId,
    );
  };
  return { db, deviceId, notesIn, setNotes };
}

test('a list shows the before-image until the delay passes', (t) => {
  const { db, notesIn, setNotes } = seeded(t);
  setNotes('first', T0);
  const during = listedRelation(db, 'devices', T0 + D - 1, D);
  assert.equal(during, 'devices_listed');
  assert.equal(notesIn(during), null);
  assert.equal(notesIn('devices'), 'first');
  const after = listedRelation(db, 'devices', T0 + D, D);
  assert.equal(after, 'devices');
  assert.equal(notesIn(after), 'first');
});

test('two writes surface one delay after each write', (t) => {
  const { db, notesIn, setNotes } = seeded(t);
  setNotes('first', T0);
  setNotes('second', T0 + 180_000);
  assert.equal(notesIn(listedRelation(db, 'devices', T0 + 1000, D)), null);
  assert.equal(
    notesIn(listedRelation(db, 'devices', T0 + D + 1000, D)),
    'first',
  );
  assert.equal(
    notesIn(listedRelation(db, 'devices', T0 + 180_000 + D, D)),
    'second',
  );
});

test('an insert hides the row and a delete keeps it until the delay passes', (t) => {
  const { db, deviceId } = seeded(t);
  const count = (relation: string) =>
    Number(
      row<{ n: number }>(
        db.prepare(`SELECT count(*) AS n FROM ${relation}`).get(),
      )?.n,
    );
  const before = count('devices');
  saveBeforeImage(db, 'devices', deviceId, T0, D);
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
  const columns = columnsOf(db, 'users');
  const userId = '199999999999999999999';
  saveBeforeImage(db, 'users', userId, T0, D);
  db.prepare(
    `INSERT INTO users (${columns.join(', ')}) SELECT ${columns
      .map((column) =>
        column === 'id'
          ? '?'
          : column === 'primary_email'
            ? "'new@lag.test'"
            : column,
      )
      .join(', ')} FROM users ORDER BY ord LIMIT 1`,
  ).run(userId);
  const devices = listedRelation(db, 'devices', T0 + 1, D);
  assert.equal(count(devices), before);
  const users = listedRelation(db, 'users', T0 + 1, D);
  assert.equal(
    row(db.prepare(`SELECT id FROM ${users} WHERE id = ?`).get(userId)),
    undefined,
  );
  assert.equal(count(listedRelation(db, 'devices', T0 + D, D)), before - 1);
});

test('a delay of 0 saves nothing', (t) => {
  const { db, deviceId } = seeded(t);
  saveBeforeImage(db, 'devices', deviceId, T0, 0);
  assert.equal(saveBeforeImagesWhere(db, 'devices', '1 = 1', [], T0, 0), 0);
  assert.equal(pendingLag(db, T0, D), 0);
});

test('bulk before-images, the pending count, and flush', (t) => {
  const { db } = seeded(t);
  assert.equal(
    saveBeforeImagesWhere(db, 'devices', 'ord < ?', [10], T0, D),
    10,
  );
  assert.equal(pendingLag(db, T0 + 1, D), 10);
  assert.equal(pendingLag(db, T0 + D, D), 0);
  assert.equal(flushLag(db), 10);
  assert.equal(listedRelation(db, 'devices', T0 + 1, D), 'devices');
});

test('deleted_users holds every users column', (t) => {
  const { db } = seeded(t);
  const deleted = new Set(columnsOf(db, 'deleted_users'));
  for (const column of columnsOf(db, 'users'))
    assert.ok(deleted.has(column), column);
  assert.ok(deleted.has('deleted_at'));
  assert.ok(deleted.has('aliases'));
});

test('a milestone 1 domain file gains the new columns and tables', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lag-m1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, primary_email TEXT NOT NULL UNIQUE, given_name TEXT NOT NULL,
    family_name TEXT NOT NULL, full_name TEXT NOT NULL, org_unit_path TEXT NOT NULL,
    is_admin INTEGER NOT NULL, suspended INTEGER NOT NULL, suspension_reason TEXT,
    external_id TEXT, role TEXT NOT NULL, school INTEGER, creation_time INTEGER NOT NULL,
    last_login_time INTEGER, ord INTEGER NOT NULL)`);
  old.exec(
    "INSERT INTO users VALUES ('1', 'a@old.test', 'A', 'B', 'A B', '/', 1, 0, NULL, NULL, 'admin', NULL, 0, NULL, 0)",
  );
  old.close();
  const db = openDomainDb(path);
  t.after(() => db.close());
  const columns = columnsOf(db, 'users');
  assert.ok(columns.includes('change_password_at_next_login'));
  assert.ok(columns.includes('external_ids'));
  const tables = rows<{ name: string }>(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .all(),
  ).map((entry) => entry.name);
  for (const name of [
    'deleted_users',
    'device_commands',
    'users_prior',
    'users_listed',
    'devices_listed',
  ])
    assert.ok(tables.includes(name), name);
  saveBeforeImage(db, 'users', '1', T0, D);
  db.prepare("UPDATE users SET given_name = 'C' WHERE id = '1'").run();
  assert.equal(
    row<{ given_name: string }>(
      db
        .prepare(`SELECT given_name FROM ${listedRelation(db, 'users', T0, D)}`)
        .get(),
    )?.given_name,
    'A',
  );
});

test('listedSelect matches the listed view and merges the compound arms', (t) => {
  const { db } = seeded(t);
  const ids = rows<{ device_id: string; org_unit_path: string }>(
    db
      .prepare('SELECT device_id, org_unit_path FROM devices ORDER BY ord')
      .all(),
  );
  const unit = ids[0]!.org_unit_path;
  const query = (
    relation: string,
    where: string[],
    params: (string | number)[],
  ) => {
    const built = listedSelect(db, 'devices', relation, {
      extra: 'ord AS sort_key',
      where,
      params,
      tail: 'ORDER BY sort_key ASC, device_id ASC LIMIT ?',
    });
    return {
      sql: built.sql,
      params: [...built.params, 1000],
      rows: rows(db.prepare(built.sql).all(...built.params, 1000)),
    };
  };
  const viaView = (where: string[], params: (string | number)[]) =>
    rows(
      db
        .prepare(
          `SELECT *, ord AS sort_key FROM devices_listed ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sort_key, device_id LIMIT ?`,
        )
        .all(...params, 1000),
    );
  const cases: [string[], (string | number)[]][] = [
    [[], []],
    [['org_unit_path = ?'], [unit]],
    [['(ord, device_id) > (?, ?)'], [5, ids[5]!.device_id]],
    [
      ['org_unit_path = ?', '(ord, device_id) > (?, ?)'],
      [unit, 2, ids[2]!.device_id],
    ],
  ];
  for (const [where, params] of cases) {
    const live = query('devices', where, params);
    assert.equal(live.sql.includes('UNION'), false);
    assert.deepEqual(
      live.rows,
      rows(
        db
          .prepare(
            `SELECT *, ord AS sort_key FROM devices ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sort_key, device_id LIMIT ?`,
          )
          .all(...params, 1000),
      ),
    );
  }

  const columns = columnsOf(db, 'devices');
  saveBeforeImage(db, 'devices', ids[0]!.device_id, T0, D);
  db.prepare(
    'UPDATE devices SET org_unit_path = ?, ord = ord + 1000 WHERE device_id = ?',
  ).run('/Moved', ids[0]!.device_id);
  saveBeforeImage(db, 'devices', ids[1]!.device_id, T0, D);
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(ids[1]!.device_id);
  saveBeforeImage(db, 'devices', 'brand-new', T0, D);
  db.prepare(
    `INSERT INTO devices (${columns.join(', ')}) SELECT ${columns
      .map((c) =>
        c === 'device_id'
          ? "'brand-new'"
          : c === 'serial_number'
            ? "'NEW-SERIAL'"
            : c,
      )
      .join(', ')} FROM devices WHERE device_id = ?`,
  ).run(ids[2]!.device_id);
  saveBeforeImage(db, 'devices', ids[3]!.device_id, T0 + 1, D);
  db.prepare('UPDATE devices SET notes = ? WHERE device_id = ?').run(
    'again',
    ids[3]!.device_id,
  );

  const relation = listedRelation(db, 'devices', T0 + 2, D);
  assert.equal(relation, 'devices_listed');
  for (const [where, params] of cases) {
    const lagged = query(relation, where, params);
    assert.deepEqual(lagged.rows, viaView(where, params));
    assert.ok(lagged.rows.length > 0);
  }
  const plan = rows<{ detail: string }>(
    db
      .prepare(`EXPLAIN QUERY PLAN ${query(relation, [], []).sql}`)
      .all(...query(relation, [], []).params),
  );
  assert.ok(
    plan.some((step) => step.detail.includes('MERGE')),
    plan.map((step) => step.detail).join('\n'),
  );
});

test('group tables lag, and numeric member keys keep their before-images', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lag-groups-'));
  const db = openDomainDb(join(dir, 'domain.sqlite'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const view of [
    'groups_listed',
    'group_aliases_listed',
    'group_members_listed',
  ])
    assert.ok(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?")
        .get(view),
      view,
    );
  const insert = db.prepare(
    "INSERT INTO group_members (id, group_id, member_id, email, type, role, delivery, added_at) VALUES (?, 'g1', ?, ?, 'USER', 'MEMBER', 'ALL_MAIL', 0)",
  );
  insert.run(1, 'u1', 'one@lake.test');
  // A new membership hides behind an absent marker.
  saveBeforeImage(db, 'group_members', 2, 1_000, 60_000);
  insert.run(2, 'u2', 'two@lake.test');
  // A removed membership stays listed through its before-image.
  saveBeforeImage(db, 'group_members', 1, 1_000, 60_000);
  db.prepare('DELETE FROM group_members WHERE id = 1').run();
  const listed = (now: number) =>
    db
      .prepare(
        `SELECT member_id FROM ${listedRelation(db, 'group_members', now, 60_000)} ORDER BY member_id`,
      )
      .all()
      .map((entry) => (entry as { member_id: string }).member_id);
  assert.deepEqual(listed(2_000), ['u1']);
  assert.deepEqual(listed(70_000), ['u2']);
});

test('a milestone 2 file gains the group tables and deleted_users.memberships', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lag-migrate-'));
  const path = join(dir, 'domain.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new DatabaseSync(path);
  old.exec(
    "CREATE TABLE deleted_users (id TEXT PRIMARY KEY, primary_email TEXT NOT NULL, given_name TEXT NOT NULL, family_name TEXT NOT NULL, full_name TEXT NOT NULL, org_unit_path TEXT NOT NULL, is_admin INTEGER NOT NULL, suspended INTEGER NOT NULL, suspension_reason TEXT, external_id TEXT, role TEXT NOT NULL, school INTEGER, creation_time INTEGER NOT NULL, last_login_time INTEGER, ord INTEGER NOT NULL, change_password_at_next_login INTEGER NOT NULL DEFAULT 0, external_ids TEXT, deleted_at INTEGER NOT NULL, aliases TEXT NOT NULL DEFAULT '[]')",
  );
  old.close();
  const db = openDomainDb(path);
  t.after(() => db.close());
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name,
    );
  assert.ok(columns('deleted_users').includes('memberships'));
  assert.ok(columns('deleted_users_prior').includes('memberships'));
  for (const table of ['groups', 'group_aliases', 'group_members'])
    assert.ok(columns(table).length > 0, table);
});
