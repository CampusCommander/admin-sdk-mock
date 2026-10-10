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
