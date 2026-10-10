import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { validateSchema } from '../config/json-schema.ts';
import { reaches } from '../directory/group-graph.ts';
import { createRandom } from '../random.ts';
import { addressInUse, domainKind } from '../store/addresses.ts';
import {
  findGroup,
  newGroupId,
  outsideMemberId,
  ROLES,
  type MemberType,
} from '../store/group-lookup.ts';
import { row } from '../store/sqlite.ts';
import { findUser } from '../store/user-lookup.ts';
import { DAY_MS, HEX } from './context.ts';
import {
  DEPROVISION_REASONS,
  DEVICE_COLUMNS,
  LICENSE_TYPES,
  type StoredDevice,
} from './devices.ts';
import { ouId } from './layout.ts';
import {
  aueMs,
  CURRENT_MODELS,
  CURRENT_OS,
  EXPIRED_MODELS,
  frozenOs,
  MODEL_BY_NAME,
  PLATFORM_FOR_OS,
} from './models.ts';
import type { ResolvedSpec } from './spec.ts';

export interface FixtureOrgUnit {
  path: string;
  description?: string;
}

export interface FixtureUser {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  orgUnitPath?: string;
  isAdmin?: boolean;
  suspended?: boolean;
  aliases?: string[];
  externalIds?: { value: string; type?: string }[];
  id?: string;
}

export interface FixtureDevice {
  serialNumber: string;
  model?: string;
  status?: 'ACTIVE' | 'DISABLED' | 'DEPROVISIONED';
  orgUnitPath?: string;
  annotatedUser?: string;
  annotatedAssetId?: string;
  annotatedLocation?: string;
  notes?: string;
  lastSync?: string;
  deviceId?: string;
}

export interface FixtureMember {
  email?: string;
  id?: string;
  role?: 'OWNER' | 'MANAGER' | 'MEMBER';
  /** When given, it must equal the type that the key names. An outside address is a USER. */
  type?: MemberType;
}

export interface FixtureGroup {
  email: string;
  name?: string;
  description?: string;
  aliases?: string[];
  members?: FixtureMember[];
}

/** A parsed fixtures file. Every section is present. */
export interface Fixtures {
  orgUnits: FixtureOrgUnit[];
  users: FixtureUser[];
  devices: FixtureDevice[];
  groups: FixtureGroup[];
}

export interface FixtureCounts {
  orgUnits: number;
  users: number;
  devices: number;
  groups: number;
}

/** Every problem in a fixtures file, each as `<file>: <json path> <problem>`. */
export class FixtureError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join('\n'));
    this.name = 'FixtureError';
    this.errors = errors;
  }
}

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const STRINGS = { type: 'array', items: STRING };
const entries = (required: string[], properties: Record<string, unknown>) => ({
  type: 'array',
  items: { type: 'object', additionalProperties: false, required, properties },
});

const FIXTURES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    orgUnits: entries(['path'], { path: STRING, description: STRING }),
    users: entries(['primaryEmail', 'givenName', 'familyName'], {
      primaryEmail: STRING,
      givenName: STRING,
      familyName: STRING,
      orgUnitPath: STRING,
      isAdmin: BOOLEAN,
      suspended: BOOLEAN,
      aliases: STRINGS,
      externalIds: entries(['value'], { value: STRING, type: STRING }),
      id: STRING,
    }),
    devices: entries(['serialNumber'], {
      serialNumber: STRING,
      model: STRING,
      status: { enum: ['ACTIVE', 'DISABLED', 'DEPROVISIONED'] },
      orgUnitPath: STRING,
      annotatedUser: STRING,
      annotatedAssetId: STRING,
      annotatedLocation: STRING,
      notes: STRING,
      lastSync: STRING,
      deviceId: STRING,
    }),
    groups: entries(['email'], {
      email: STRING,
      name: STRING,
      description: STRING,
      aliases: STRINGS,
      members: entries([], {
        email: STRING,
        id: STRING,
        role: { enum: ROLES },
        type: { enum: ['USER', 'GROUP', 'CUSTOMER'] },
      }),
    }),
  },
};

const EMAIL = /^[^@\s]+@[^@\s]+$/;
/** The member-key form of an outside address, as `members.insert` reads it. */
const OUTSIDE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const OU_PATH = /^\/$|^(\/[^/]+)+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DIGITS = '0123456789';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The string formats that the schema subset cannot express. Values of the wrong type are skipped. */
function formatErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const check = (
    input: unknown,
    path: string,
    valid: (text: string) => boolean,
    problem: string,
  ) => {
    if (typeof input === 'string' && !valid(input))
      errors.push(`${path} ${problem}`);
  };
  const email = (input: unknown, path: string) =>
    check(input, path, (text) => EMAIL.test(text), 'must be an email address.');
  const ouPath = (input: unknown, path: string) =>
    check(
      input,
      path,
      (text) => OU_PATH.test(text),
      'must be / or a path such as /Schools/North.',
    );
  const filled = (input: unknown, path: string) =>
    check(input, path, (text) => text.trim() !== '', 'must not be empty.');
  const each = (
    list: unknown,
    path: string,
    visit: (item: Record<string, unknown>, at: string) => void,
  ) => {
    if (Array.isArray(list))
      list.forEach((item, index) => {
        if (isObject(item)) visit(item, `${path}[${index}]`);
      });
  };
  const addresses = (list: unknown, path: string) => {
    if (Array.isArray(list))
      list.forEach((item, index) => email(item, `${path}[${index}]`));
  };

  each(value.orgUnits, 'orgUnits', (unit, at) =>
    ouPath(unit.path, `${at}.path`),
  );
  each(value.users, 'users', (user, at) => {
    email(user.primaryEmail, `${at}.primaryEmail`);
    filled(user.givenName, `${at}.givenName`);
    filled(user.familyName, `${at}.familyName`);
    ouPath(user.orgUnitPath, `${at}.orgUnitPath`);
    addresses(user.aliases, `${at}.aliases`);
    check(user.id, `${at}.id`, (text) => /^\d+$/.test(text), 'must be digits.');
  });
  each(value.devices, 'devices', (device, at) => {
    filled(device.serialNumber, `${at}.serialNumber`);
    ouPath(device.orgUnitPath, `${at}.orgUnitPath`);
    check(
      device.lastSync,
      `${at}.lastSync`,
      (text) => ISO_TIME.test(text) && !Number.isNaN(Date.parse(text)),
      'must be an ISO 8601 time.',
    );
    filled(device.deviceId, `${at}.deviceId`);
  });
  each(value.groups, 'groups', (group, at) => {
    email(group.email, `${at}.email`);
    addresses(group.aliases, `${at}.aliases`);
    each(group.members, `${at}.members`, (member, memberAt) => {
      if ((member.email === undefined) === (member.id === undefined))
        errors.push(`${memberAt} must have exactly one of email and id.`);
      email(member.email, `${memberAt}.email`);
    });
  });
  return errors;
}

/** Check a fixtures file's shape and fill the missing sections with empty lists. */
export function parseFixtures(value: unknown, file: string): Fixtures {
  if (!isObject(value))
    throw new FixtureError([`${file}: The fixtures file must be an object.`]);
  const errors = [
    ...validateSchema(FIXTURES_SCHEMA, value),
    ...formatErrors(value),
  ];
  if (errors.length > 0)
    throw new FixtureError(errors.map((error) => `${file}: ${error}`));
  const input = value as Partial<Fixtures>;
  return {
    orgUnits: input.orgUnits ?? [],
    users: input.users ?? [],
    devices: input.devices ?? [],
    groups: input.groups ?? [],
  };
}

/** Read and parse a fixtures file. */
export function loadFixtures(file: string): Fixtures {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new FixtureError([
      `${file}: The fixtures file cannot be read (${(error as Error).message}).`,
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new FixtureError([
      `${file}: The fixtures file is not valid JSON (${(error as Error).message}).`,
    ]);
  }
  return parseFixtures(value, file);
}

interface OuRef {
  org_unit_id: string;
  path: string;
  depth: number;
}

/** The state that every fixture section shares while it writes. */
function writer(db: DatabaseSync, file: string) {
  const errors: string[] = [];
  const exact = db.prepare(
    'SELECT org_unit_id, path, depth FROM orgunits WHERE path = ?',
  );
  return {
    errors,
    fail: (path: string, problem: string) =>
      errors.push(`${file}: ${path} ${problem}`),
    orgUnit: (path: string) => row<OuRef>(exact.get(path)),
    nextOrd: (sql: string) =>
      Number(row<{ n: number }>(db.prepare(sql).get())!.n),
    /** Fail when an address is off the customer's own domains or already taken. */
    address(email: string, path: string, pending: Set<string>): void {
      if (domainKind(db, email) !== 'own')
        this.fail(path, "must be on one of the customer's domains.");
      else if (addressInUse(db, email) || pending.has(email))
        this.fail(path, 'is already in use.');
      pending.add(email);
    },
  };
}

type Writer = ReturnType<typeof writer>;

function addOrgUnits(
  db: DatabaseSync,
  spec: ResolvedSpec,
  out: Writer,
  units: readonly FixtureOrgUnit[],
): number {
  const described = new Map<string, string>();
  for (const unit of units)
    if (!described.has(unit.path))
      described.set(unit.path, unit.description ?? '');
  const anyCase = db.prepare(
    'SELECT path FROM orgunits WHERE lower(path) = lower(?)',
  );
  const insert = db.prepare(
    "INSERT INTO orgunits (org_unit_id, path, name, description, parent_id, parent_path, depth, kind, ord) VALUES (?, ?, ?, ?, ?, ?, ?, 'container', ?)",
  );
  let ord = out.nextOrd('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM orgunits');
  let added = 0;
  units.forEach((unit, index) => {
    const names = unit.path.split('/').filter(Boolean);
    let parent = out.orgUnit('/')!;
    for (let depth = 1; depth <= names.length; depth++) {
      const path = `/${names.slice(0, depth).join('/')}`;
      const existing = out.orgUnit(path);
      if (existing) {
        parent = existing;
        continue;
      }
      const other = row<{ path: string }>(anyCase.get(path));
      if (other) {
        out.fail(
          `orgUnits[${index}].path`,
          `differs from the OU ${other.path} only in case.`,
        );
        return;
      }
      const orgUnitId = ouId(spec.seed, path);
      insert.run(
        orgUnitId,
        path,
        names[depth - 1],
        described.get(path) ?? '',
        parent.org_unit_id,
        parent.path,
        parent.depth + 1,
        ord++,
      );
      added++;
      parent = { org_unit_id: orgUnitId, path, depth: parent.depth + 1 };
    }
  });
  return added;
}

function addUsers(
  db: DatabaseSync,
  spec: ResolvedSpec,
  out: Writer,
  users: readonly FixtureUser[],
  seededAt: number,
): number {
  const insert = db.prepare(
    "INSERT INTO users (id, primary_email, given_name, family_name, full_name, org_unit_path, is_admin, suspended, suspension_reason, external_id, role, school, creation_time, last_login_time, ord, external_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staff', NULL, ?, NULL, ?, ?)",
  );
  const insertAlias = db.prepare(
    'INSERT INTO user_aliases (alias, user_id) VALUES (?, ?)',
  );
  const idUsed = db.prepare(
    'SELECT 1 FROM users WHERE id = ? UNION ALL SELECT 1 FROM deleted_users WHERE id = ?',
  );
  const taken = (id: string) => idUsed.get(id, id) !== undefined;
  let ord = out.nextOrd(
    'SELECT MAX(COALESCE((SELECT MAX(ord) FROM users), -1), COALESCE((SELECT MAX(ord) FROM deleted_users), -1)) + 1 AS n',
  );
  let added = 0;
  users.forEach((user, index) => {
    const at = `users[${index}]`;
    const before = out.errors.length;
    const pending = new Set<string>();
    const email = user.primaryEmail.toLowerCase();
    out.address(email, `${at}.primaryEmail`, pending);
    const aliases = (user.aliases ?? []).map((alias) => alias.toLowerCase());
    aliases.forEach((alias, n) =>
      out.address(alias, `${at}.aliases[${n}]`, pending),
    );
    const ou = user.orgUnitPath ?? '/';
    if (!out.orgUnit(ou)) out.fail(`${at}.orgUnitPath`, 'names no OU.');
    if (user.id !== undefined && taken(user.id))
      out.fail(`${at}.id`, 'is already in use.');
    if (out.errors.length > before) return;
    let id = user.id;
    if (id === undefined) {
      const random = createRandom(`fixture-user/${spec.seed}/${email}`);
      do id = `1${random.string(20, DIGITS)}`;
      while (taken(id));
    }
    const external = user.externalIds ?? [];
    insert.run(
      id,
      email,
      user.givenName,
      user.familyName,
      `${user.givenName} ${user.familyName}`,
      ou,
      user.isAdmin ? 1 : 0,
      user.suspended ? 1 : 0,
      user.suspended ? 'ADMIN' : null,
      external[0]?.value ?? null,
      seededAt - 30 * DAY_MS,
      ord++,
      external.length > 0 ? JSON.stringify(external) : null,
    );
    for (const alias of aliases) insertAlias.run(alias, id);
    added++;
  });
  return added;
}

function addDevices(
  db: DatabaseSync,
  spec: ResolvedSpec,
  out: Writer,
  devices: readonly FixtureDevice[],
  seededAt: number,
): number {
  const insert = db.prepare(
    `INSERT INTO devices (${DEVICE_COLUMNS.join(', ')}) VALUES (${DEVICE_COLUMNS.map(() => '?').join(', ')})`,
  );
  const serialUsed = db.prepare(
    'SELECT 1 FROM devices WHERE serial_number = ?',
  );
  const idUsed = db.prepare('SELECT 1 FROM devices WHERE device_id = ?');
  let ord = out.nextOrd('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM devices');
  let added = 0;
  devices.forEach((device, index) => {
    const at = `devices[${index}]`;
    const before = out.errors.length;
    // Every draw happens in a fixed order, so a supplied field never shifts another field's value.
    const random = createRandom(
      `fixture-device/${spec.seed}/${device.serialNumber}`,
    );
    const deviceId = random.uuid();
    if (serialUsed.get(device.serialNumber))
      out.fail(`${at}.serialNumber`, 'is already in use.');
    const info = MODEL_BY_NAME.get(device.model ?? CURRENT_MODELS[0].name);
    if (!info) out.fail(`${at}.model`, 'names no model in the catalog.');
    const unit = out.orgUnit(device.orgUnitPath ?? '/');
    if (!unit) out.fail(`${at}.orgUnitPath`, 'names no OU.');
    if (idUsed.get(device.deviceId ?? deviceId))
      out.fail(`${at}.deviceId`, 'is already in use.');
    if (out.errors.length > before || !info || !unit) return;

    const status = device.status ?? 'ACTIVE';
    const lastSync =
      device.lastSync === undefined
        ? seededAt - DAY_MS
        : Date.parse(device.lastSync);
    const aueYear = Number(info.aue.slice(0, 4));
    const purchase = Math.min(
      Date.UTC(
        aueYear - 10 + random.int(0, 2),
        random.int(5, 8),
        random.int(1, 28),
      ),
      seededAt - 30 * DAY_MS,
    );
    const firstEnrollment = Math.min(
      purchase + random.int(1, 60) * DAY_MS,
      lastSync - DAY_MS,
    );
    const currentOs = random.weighted(CURRENT_OS);
    const osVersion = EXPIRED_MODELS.includes(info)
      ? frozenOs(info.aue)
      : currentOs;
    const recent =
      device.annotatedUser !== undefined && status !== 'DEPROVISIONED'
        ? [device.annotatedUser]
        : [];
    const activity = random.int(0, 6 * 3_600_000);
    const reason = random.pick(DEPROVISION_REASONS);
    const deprovisionDays = random.int(1, 30);
    const stored: StoredDevice = {
      device_id: device.deviceId ?? deviceId,
      serial_number: device.serialNumber,
      status,
      model: info.name,
      org_unit_path: unit.path,
      org_unit_id: unit.org_unit_id,
      annotated_user: device.annotatedUser ?? null,
      annotated_asset_id: device.annotatedAssetId ?? null,
      annotated_location: device.annotatedLocation ?? null,
      notes: device.notes ?? null,
      last_sync: lastSync,
      first_enrollment_time: firstEnrollment,
      last_enrollment_time: firstEnrollment,
      mac_address: random.string(12, HEX),
      ethernet_mac_address: random.chance(0.3) ? random.string(12, HEX) : null,
      os_version: osVersion,
      platform_version: `${PLATFORM_FOR_OS[osVersion]} (Official Build) stable-channel ${info.board}`,
      firmware_version: `Google_${info.board[0].toUpperCase()}${info.board.slice(1)}.${random.int(10_000, 15_999)}.${random.int(0, 500)}.0`,
      boot_mode: 'Verified',
      aue: aueMs(info.aue),
      recent_users: recent.length > 0 ? JSON.stringify(recent) : null,
      last_user_activity: recent.length > 0 ? lastSync - activity : null,
      has_battery: 1,
      ram_total: info.ramGb * 1024 ** 3,
      storage_total: info.storageGb * 1_000_000_000,
      order_number: null,
      license_type: random.weighted(LICENSE_TYPES),
      deprovision_reason: status === 'DEPROVISIONED' ? reason : null,
      last_deprovision:
        status === 'DEPROVISIONED'
          ? Math.min(lastSync + deprovisionDays * DAY_MS, seededAt)
          : null,
      category: 'one-to-one',
      misplaced: 0,
      ord: ord++,
    };
    insert.run(...DEVICE_COLUMNS.map((column) => stored[column]));
    added++;
  });
  return added;
}

interface Target {
  id: string;
  email: string;
  type: MemberType;
}

function addGroups(
  db: DatabaseSync,
  spec: ResolvedSpec,
  out: Writer,
  groups: readonly FixtureGroup[],
  seededAt: number,
): number {
  const createdAt = seededAt - 30 * DAY_MS;
  const insertGroup = db.prepare(
    'INSERT INTO groups (id, email, name, description, admin_created, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  );
  const insertAlias = db.prepare(
    'INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)',
  );
  const insertMember = db.prepare(
    "INSERT INTO group_members (group_id, member_id, email, type, role, delivery, added_at) VALUES (?, ?, ?, ?, ?, 'ALL_MAIL', ?)",
  );
  const idUsed = db.prepare('SELECT 1 FROM groups WHERE id = ?');
  const memberUsed = db.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND email = ? AND member_id = ?',
  );

  // Every group exists before any alias or member, so members may name groups defined later.
  const ids = groups.map((group, index) => {
    const email = group.email.toLowerCase();
    const before = out.errors.length;
    out.address(email, `groups[${index}].email`, new Set());
    if (out.errors.length > before) return null;
    const id = newGroupId(
      createRandom(`fixture-group/${spec.seed}/${email}`),
      (candidate) => idUsed.get(candidate) !== undefined,
    );
    insertGroup.run(
      id,
      email,
      group.name ?? email.slice(0, email.indexOf('@')),
      group.description ?? '',
      createdAt,
    );
    return id;
  });
  groups.forEach((group, index) => {
    const id = ids[index];
    if (id === null) return;
    const pending = new Set<string>();
    (group.aliases ?? []).forEach((raw, n) => {
      const alias = raw.toLowerCase();
      const before = out.errors.length;
      out.address(alias, `groups[${index}].aliases[${n}]`, pending);
      if (out.errors.length === before) insertAlias.run(alias, id);
    });
  });

  const resolve = (key: string): Target | undefined => {
    const user = findUser(db, key);
    if (user) return { id: user.id, email: user.primary_email, type: 'USER' };
    const found = findGroup(db, key);
    if (found) return { id: found.id, email: found.email, type: 'GROUP' };
    if (key === spec.customerId)
      return { id: key, email: '', type: 'CUSTOMER' };
    if (OUTSIDE_EMAIL.test(key) && domainKind(db, key) === 'outside') {
      const email = key.toLowerCase();
      return { id: outsideMemberId(email), email, type: 'USER' };
    }
    return undefined;
  };
  groups.forEach((group, index) => {
    const id = ids[index];
    if (id === null) return;
    (group.members ?? []).forEach((member, n) => {
      const at = `groups[${index}].members[${n}]`;
      const target = resolve((member.email ?? member.id)!);
      if (!target)
        out.fail(at, 'names no user, group, customer, or outside address.');
      else if (member.type !== undefined && member.type !== target.type)
        out.fail(
          `${at}.type`,
          `is ${member.type} but the key names a ${target.type}.`,
        );
      else if (memberUsed.get(id, target.email, target.id))
        out.fail(at, 'is already a member.');
      // Each link is checked against the links before it, so a cycle fails at the link that closes it.
      else if (target.type === 'GROUP' && reaches(db, target.id, id))
        out.fail(at, 'makes a membership cycle.');
      else
        insertMember.run(
          id,
          target.id,
          target.email,
          target.type,
          member.role ?? 'MEMBER',
          createdAt,
        );
    });
  });
  return ids.filter((id) => id !== null).length;
}

/**
 * Write the fixtures into a seeded domain: OUs, users, devices, then groups.
 * Runs inside the caller's transaction. Every reference error is collected and
 * thrown as one FixtureError, so the caller's transaction rolls back.
 */
export function applyFixtures(
  db: DatabaseSync,
  spec: ResolvedSpec,
  fixtures: Fixtures,
  seededAt: number,
  file: string,
): FixtureCounts {
  const out = writer(db, file);
  const counts: FixtureCounts = {
    orgUnits: addOrgUnits(db, spec, out, fixtures.orgUnits),
    users: addUsers(db, spec, out, fixtures.users, seededAt),
    devices: addDevices(db, spec, out, fixtures.devices, seededAt),
    groups: addGroups(db, spec, out, fixtures.groups, seededAt),
  };
  if (out.errors.length > 0) throw new FixtureError(out.errors);
  db.prepare(
    "UPDATE meta SET value = CAST((SELECT count(*) FROM devices) AS TEXT) WHERE key = 'deviceCount'",
  ).run();
  return counts;
}
