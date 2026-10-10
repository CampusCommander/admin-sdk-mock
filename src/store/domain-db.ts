import type { DatabaseSync } from 'node:sqlite';
import { createLagSchema } from './lag.ts';
import { openDatabase, rows } from './sqlite.ts';
import { registerTextFunctions } from './text.ts';

export const DOMAIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS domains (
  domain_name TEXT PRIMARY KEY,
  is_primary INTEGER NOT NULL,
  verified INTEGER NOT NULL,
  creation_time INTEGER NOT NULL,
  alias_of TEXT
);
CREATE TABLE IF NOT EXISTS orgunits (
  org_unit_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  parent_id TEXT,
  parent_path TEXT,
  depth INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ord INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orgunits_parent ON orgunits (parent_id, ord);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  primary_email TEXT NOT NULL UNIQUE,
  given_name TEXT NOT NULL,
  family_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  org_unit_path TEXT NOT NULL,
  is_admin INTEGER NOT NULL,
  suspended INTEGER NOT NULL,
  suspension_reason TEXT,
  external_id TEXT,
  role TEXT NOT NULL,
  school INTEGER,
  creation_time INTEGER NOT NULL,
  last_login_time INTEGER,
  ord INTEGER NOT NULL,
  change_password_at_next_login INTEGER NOT NULL DEFAULT 0,
  external_ids TEXT
);
CREATE INDEX IF NOT EXISTS users_ou ON users (org_unit_path);
CREATE INDEX IF NOT EXISTS users_family ON users (family_name, id);
CREATE INDEX IF NOT EXISTS users_given ON users (given_name, id);
CREATE INDEX IF NOT EXISTS users_ord ON users (ord);
CREATE TABLE IF NOT EXISTS user_aliases (
  alias TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS user_aliases_user ON user_aliases (user_id);
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  serial_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  org_unit_path TEXT NOT NULL,
  org_unit_id TEXT NOT NULL,
  annotated_user TEXT,
  annotated_asset_id TEXT,
  annotated_location TEXT,
  notes TEXT,
  last_sync INTEGER,
  first_enrollment_time INTEGER NOT NULL,
  last_enrollment_time INTEGER NOT NULL,
  mac_address TEXT NOT NULL,
  ethernet_mac_address TEXT,
  os_version TEXT NOT NULL,
  platform_version TEXT NOT NULL,
  firmware_version TEXT NOT NULL,
  boot_mode TEXT NOT NULL,
  aue INTEGER NOT NULL,
  recent_users TEXT,
  last_user_activity INTEGER,
  has_battery INTEGER NOT NULL,
  ram_total INTEGER NOT NULL,
  storage_total INTEGER NOT NULL,
  order_number TEXT,
  license_type TEXT NOT NULL,
  deprovision_reason TEXT,
  last_deprovision INTEGER,
  category TEXT NOT NULL,
  misplaced INTEGER NOT NULL,
  ord INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_ou ON devices (org_unit_path, ord);
CREATE INDEX IF NOT EXISTS devices_status ON devices (status);
CREATE INDEX IF NOT EXISTS devices_sync ON devices (last_sync);
CREATE INDEX IF NOT EXISTS devices_ord ON devices (ord);
CREATE INDEX IF NOT EXISTS devices_asset ON devices (annotated_asset_id);
CREATE TABLE IF NOT EXISTS deleted_users (
  id TEXT PRIMARY KEY,
  primary_email TEXT NOT NULL,
  given_name TEXT NOT NULL,
  family_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  org_unit_path TEXT NOT NULL,
  is_admin INTEGER NOT NULL,
  suspended INTEGER NOT NULL,
  suspension_reason TEXT,
  external_id TEXT,
  role TEXT NOT NULL,
  school INTEGER,
  creation_time INTEGER NOT NULL,
  last_login_time INTEGER,
  ord INTEGER NOT NULL,
  change_password_at_next_login INTEGER NOT NULL DEFAULT 0,
  external_ids TEXT,
  deleted_at INTEGER NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  memberships TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS deleted_users_email ON deleted_users (primary_email);
CREATE INDEX IF NOT EXISTS deleted_users_ord ON deleted_users (ord);
CREATE TABLE IF NOT EXISTS device_commands (
  command_id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT,
  issued_at INTEGER NOT NULL,
  sent_at INTEGER,
  acked_at INTEGER,
  executed_at INTEGER,
  expire_at INTEGER NOT NULL,
  result TEXT NOT NULL,
  error_message TEXT,
  applied INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS device_commands_due ON device_commands (applied, executed_at);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  admin_created INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_aliases (
  alias TEXT PRIMARY KEY,
  group_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS group_aliases_group ON group_aliases (group_id);
CREATE TABLE IF NOT EXISTS group_members (
  id INTEGER PRIMARY KEY,
  group_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  email TEXT NOT NULL,
  type TEXT NOT NULL,
  role TEXT NOT NULL,
  delivery TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS group_members_order ON group_members (group_id, email, member_id);
CREATE INDEX IF NOT EXISTS group_members_email ON group_members (email, member_id);
CREATE INDEX IF NOT EXISTS group_members_links ON group_members (group_id, member_id) WHERE type = 'GROUP';
`;

/** Columns that later milestones added to tables in earlier files. */
const ADDED_COLUMNS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  users: {
    change_password_at_next_login: 'INTEGER NOT NULL DEFAULT 0',
    external_ids: 'TEXT',
  },
  deleted_users: {
    memberships: "TEXT NOT NULL DEFAULT '[]'",
  },
};

function addMissingColumns(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(
      rows<{ name: string }>(
        db.prepare(`PRAGMA table_info(${table})`).all(),
      ).map((column) => column.name),
    );
    for (const [name, type] of Object.entries(columns))
      if (!existing.has(name))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/** Open one domain file and create its tables and views when they are missing. */
export function openDomainDb(path: string): DatabaseSync {
  const db = openDatabase(path);
  db.exec(DOMAIN_SCHEMA);
  addMissingColumns(db);
  createLagSchema(db);
  registerTextFunctions(db);
  return db;
}
