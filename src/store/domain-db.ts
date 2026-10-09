import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './sqlite.ts';

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
  ord INTEGER NOT NULL
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
`;

/** Open one domain file and create its tables when they are missing. */
export function openDomainDb(path: string): DatabaseSync {
  const db = openDatabase(path);
  db.exec(DOMAIN_SCHEMA);
  return db;
}
