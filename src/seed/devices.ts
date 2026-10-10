import { createRandom, type Random } from '../random.ts';
import { DAY_MS, HEX, weightedIndex, type SeedContext } from './context.ts';
import type { DeviceCategory } from './layout.ts';
import {
  aueMs,
  CURRENT_MODELS,
  CURRENT_OS,
  EXPIRED_MODELS,
  frozenOs,
  PLATFORM_FOR_OS,
  type ModelInfo,
} from './models.ts';
import type { UserIndex } from './users.ts';

/** One row of the `devices` table. */
export interface StoredDevice {
  device_id: string;
  serial_number: string;
  status: string;
  model: string;
  org_unit_path: string;
  org_unit_id: string;
  annotated_user: string | null;
  annotated_asset_id: string | null;
  annotated_location: string | null;
  notes: string | null;
  last_sync: number | null;
  first_enrollment_time: number;
  last_enrollment_time: number;
  mac_address: string;
  ethernet_mac_address: string | null;
  os_version: string;
  platform_version: string;
  firmware_version: string;
  boot_mode: string;
  aue: number;
  recent_users: string | null;
  last_user_activity: number | null;
  has_battery: number;
  ram_total: number;
  storage_total: number;
  order_number: string | null;
  license_type: string;
  deprovision_reason: string | null;
  last_deprovision: number | null;
  category: string;
  misplaced: number;
  ord: number;
}

const SERIAL: Record<ModelInfo['manufacturer'], [string, number]> = {
  Lenovo: ['PF', 8],
  Acer: ['NXH', 22],
  Dell: ['', 7],
  HP: ['5CD', 10],
  ASUS: ['M', 12],
  Samsung: ['R', 15],
  CTL: ['CTL', 12],
};
const SERIAL_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const NOTES = [
  'Screen replaced',
  'Loaner device',
  'Keyboard sticky, monitor',
  'Returned from repair',
  'Battery swelling reported',
];
export const DEPROVISION_REASONS = [
  'DEPROVISION_REASON_RETIRING_DEVICE',
  'DEPROVISION_REASON_SAME_MODEL_REPLACEMENT',
  'DEPROVISION_REASON_DIFFERENT_MODEL_REPLACEMENT',
  'DEPROVISION_REASON_REPAIR_CENTER',
];
export const LICENSE_TYPES: readonly (readonly [string, number])[] = [
  ['educationUpgradePerpetual', 0.6],
  ['educationUpgrade', 0.3],
  ['education', 0.1],
];
export const DEVICE_COLUMNS = [
  'device_id',
  'serial_number',
  'status',
  'model',
  'org_unit_path',
  'org_unit_id',
  'annotated_user',
  'annotated_asset_id',
  'annotated_location',
  'notes',
  'last_sync',
  'first_enrollment_time',
  'last_enrollment_time',
  'mac_address',
  'ethernet_mac_address',
  'os_version',
  'platform_version',
  'firmware_version',
  'boot_mode',
  'aue',
  'recent_users',
  'last_user_activity',
  'has_battery',
  'ram_total',
  'storage_total',
  'order_number',
  'license_type',
  'deprovision_reason',
  'last_deprovision',
  'category',
  'misplaced',
  'ord',
] as const satisfies readonly (keyof StoredDevice)[];

/**
 * The first enrollment: a purchase in the summer about ten years before the
 * model's AUE year, then enrollment within 60 days, and never after `latest`.
 * Draws four numbers.
 */
export function enrollmentTime(
  random: Random,
  info: ModelInfo,
  seededAt: number,
  latest: number,
): number {
  const aueYear = Number(info.aue.slice(0, 4));
  const purchase = Math.min(
    Date.UTC(
      aueYear - 10 + random.int(0, 2),
      random.int(5, 8),
      random.int(1, 28),
    ),
    seededAt - 30 * DAY_MS,
  );
  return Math.min(purchase + random.int(1, 60) * DAY_MS, latest);
}

/** The Wi-Fi MAC address, and an Ethernet MAC address on 30% of devices. */
export function macAddresses(
  random: Random,
): Pick<StoredDevice, 'mac_address' | 'ethernet_mac_address'> {
  return {
    mac_address: random.string(12, HEX),
    ethernet_mac_address: random.chance(0.3) ? random.string(12, HEX) : null,
  };
}

/** The platform version string for an OS version on a model's board. Draws nothing. */
export function platformVersion(osVersion: string, info: ModelInfo): string {
  return `${PLATFORM_FOR_OS[osVersion]} (Official Build) stable-channel ${info.board}`;
}

/** A firmware version string for a model's board. Draws two numbers. */
export function firmwareVersion(random: Random, info: ModelInfo): string {
  return `Google_${info.board[0].toUpperCase()}${info.board.slice(1)}.${random.int(10_000, 15_999)}.${random.int(0, 500)}.0`;
}

/** Insert every device. The caller owns the transaction. */
export function seedDevices(ctx: SeedContext, users: UserIndex): void {
  const { spec, layout, seededAt, db } = ctx;
  const { rates } = spec;
  const random = createRandom(`devices/${spec.seed}`);
  const ouIds = new Map(
    [layout.root, ...layout.units].map((unit) => [unit.path, unit.orgUnitId]),
  );
  const chooseSchool = weightedIndex(
    layout.schools.map((school) => school.weight),
    random.fork('school'),
  );
  const assetPrefix = random.pick(['', 'CB', 'A-', 'TAG-']);
  const serials = new Set<string>();
  const insert = db.prepare(
    `INSERT INTO devices (${DEVICE_COLUMNS.join(', ')}) VALUES (${DEVICE_COLUMNS.map(() => '?').join(', ')})`,
  );

  for (let ord = 0; ord < spec.counts.devices; ord++) {
    const district = random.chance(0.03);
    const school = district ? null : layout.schools[chooseSchool()];
    const category: DeviceCategory = district
      ? 'staff'
      : random.weighted<DeviceCategory>([
          ['one-to-one', 0.77],
          ['cart', 0.1],
          ['staff', 0.12],
          ['kiosk', 0.01],
        ]);
    const roll = random.next();
    const status =
      roll < rates.disabled
        ? 'DISABLED'
        : roll < rates.disabled + rates.deprovisioned
          ? 'DEPROVISIONED'
          : 'ACTIVE';
    const expired = random.chance(rates.expired);
    const info = random.weighted(
      (expired ? EXPIRED_MODELS : CURRENT_MODELS).map(
        (entry) => [entry, entry.weight] as const,
      ),
    );
    const misplaced = random.chance(rates.misplaced);
    const deep =
      !misplaced && layout.deepDeviceOus.length > 0 && random.chance(0.02);
    const ou = misplaced
      ? school
        ? school.studentOus[random.pick(school.grades)]
        : layout.districtStaffOu
      : deep
        ? random.pick(layout.deepDeviceOus)
        : school
          ? school.deviceOus[category]
          : layout.districtDeviceOu;

    const students = school ? users.students[school.index] : [];
    const staff = school ? users.staff[school.index] : users.districtStaff;
    const unassigned = random.chance(rates.unassigned);
    let annotatedUser: string | null = null;
    let recent: string[] = [];
    if (category === 'one-to-one' && students.length > 0 && !unassigned) {
      annotatedUser = random.pick(students);
      recent = [annotatedUser];
    } else if (category === 'staff' && staff.length > 0 && !unassigned) {
      annotatedUser = random.pick(staff);
      recent = [annotatedUser];
    } else if (category === 'cart' && students.length > 0)
      recent = Array.from({ length: random.int(1, 3) }, () =>
        random.pick(students),
      );
    if (status === 'DEPROVISIONED') recent = [];

    const firstEnrollment = enrollmentTime(
      random,
      info,
      seededAt,
      seededAt - DAY_MS,
    );
    const syncRoll = random.next();
    const syncAge =
      status === 'ACTIVE'
        ? syncRoll < 0.7
          ? random.int(0, 3 * DAY_MS)
          : syncRoll < 0.9
            ? random.int(3 * DAY_MS, 30 * DAY_MS)
            : random.int(30 * DAY_MS, 365 * DAY_MS)
        : status === 'DISABLED'
          ? random.int(DAY_MS, 120 * DAY_MS)
          : random.int(365 * DAY_MS, 1095 * DAY_MS);
    const lastSync = Math.max(seededAt - syncAge, firstEnrollment + DAY_MS);
    const lastEnrollment = random.chance(0.2)
      ? firstEnrollment + random.int(0, lastSync - firstEnrollment)
      : firstEnrollment;
    const osVersion = expired
      ? frozenOs(info.aue)
      : random.weighted(CURRENT_OS);
    const [prefix, length] = SERIAL[info.manufacturer];
    let serial: string;
    do serial = prefix + random.string(length - prefix.length, SERIAL_ALPHABET);
    while (serials.has(serial));
    serials.add(serial);

    const device: StoredDevice = {
      device_id: random.uuid(),
      serial_number: serial,
      status,
      model: info.name,
      org_unit_path: ou,
      org_unit_id: ouIds.get(ou)!,
      annotated_user: annotatedUser,
      annotated_asset_id: random.chance(0.9)
        ? `${assetPrefix}${String(random.int(1, 999_999)).padStart(6, '0')}`
        : null,
      annotated_location: random.chance(0.3)
        ? random.pick([
            'Library',
            'Media Center',
            `Room ${random.int(100, 399)}`,
            category === 'cart' ? `Cart ${random.int(1, 40)}` : 'Front Office',
          ])
        : null,
      notes: random.chance(0.05) ? random.pick(NOTES) : null,
      last_sync: lastSync,
      first_enrollment_time: firstEnrollment,
      last_enrollment_time: lastEnrollment,
      ...macAddresses(random),
      os_version: osVersion,
      platform_version: platformVersion(osVersion, info),
      firmware_version: firmwareVersion(random, info),
      boot_mode: random.chance(0.005) ? 'Dev' : 'Verified',
      aue: aueMs(info.aue),
      recent_users: recent.length > 0 ? JSON.stringify(recent) : null,
      last_user_activity:
        recent.length > 0 ? lastSync - random.int(0, 6 * 3_600_000) : null,
      has_battery: random.chance(0.95) ? 1 : 0,
      ram_total: info.ramGb * 1024 ** 3,
      storage_total: info.storageGb * 1_000_000_000,
      order_number: random.chance(0.5)
        ? `PO-${random.int(10_000, 99_999)}`
        : null,
      license_type: random.weighted(LICENSE_TYPES),
      deprovision_reason:
        status === 'DEPROVISIONED' ? random.pick(DEPROVISION_REASONS) : null,
      last_deprovision:
        status === 'DEPROVISIONED'
          ? Math.min(lastSync + random.int(1, 30) * DAY_MS, seededAt)
          : null,
      category,
      misplaced: misplaced ? 1 : 0,
      ord,
    };
    insert.run(...DEVICE_COLUMNS.map((column) => device[column]));
  }
}
