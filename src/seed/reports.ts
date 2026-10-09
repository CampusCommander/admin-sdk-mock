import { createRandom } from '../random.ts';
import { DAY_MS, HEX, iso, YEAR_MS } from './context.ts';
import type { StoredDevice } from './devices.ts';
import { MODEL_BY_NAME } from './models.ts';

export const REPORT_DAYS = 30;

/** Google's classification: above 80% normal, 75% to 80% soon, below 75% now. */
export function batteryHealth(ratio: number): string {
  return ratio > 0.8
    ? 'BATTERY_HEALTH_NORMAL'
    : ratio >= 0.75
      ? 'BATTERY_REPLACE_SOON'
      : 'BATTERY_REPLACE_NOW';
}

/** The report arrays of the FULL projection, computed the same way on every read. */
export function deviceReports(
  seed: string,
  device: StoredDevice,
): Record<string, unknown> {
  if (device.last_sync === null) return {};
  const random = createRandom(`reports/${seed}/${device.device_id}`);
  const sync = device.last_sync;
  const cpu =
    MODEL_BY_NAME.get(device.model)?.cpu ?? 'Intel(R) Celeron(R) N4500';
  const cpus = 2;
  const used = Math.round(device.storage_total * (0.2 + random.next() * 0.6));
  const recent = device.recent_users
    ? (JSON.parse(device.recent_users) as string[])
    : [];
  return {
    ...(recent.length > 0
      ? {
          recentUsers: recent.map((email) => ({
            type: 'USER_TYPE_MANAGED',
            email,
          })),
        }
      : {}),
    activeTimeRanges: Array.from({ length: 7 }, (_, k) => ({
      date: iso(sync - (6 - k) * DAY_MS).slice(0, 10),
      activeTime: random.int(0, 6 * 3_600_000),
    })),
    cpuStatusReports: Array.from({ length: 3 }, (_, k) => ({
      reportTime: iso(sync - (2 - k) * 600_000),
      cpuUtilizationPercentageInfo: Array.from({ length: cpus }, () =>
        random.int(1, 95),
      ),
      cpuTemperatureInfo: [
        { label: 'Core 0', temperature: random.int(38, 78) },
      ],
    })),
    diskVolumeReports: [
      {
        volumeInfo: [
          {
            volumeId: '/home/chronos',
            storageTotal: String(device.storage_total),
            storageFree: String(device.storage_total - used),
          },
        ],
      },
    ],
    systemRamFreeReports: Array.from({ length: 3 }, (_, k) => ({
      reportTime: iso(sync - (2 - k) * 600_000),
      systemRamFreeInfo: [
        String(Math.round(device.ram_total * (0.1 + random.next() * 0.5))),
      ],
    })),
    lastKnownNetwork: [
      {
        ipAddress: `10.${random.int(0, 255)}.${random.int(0, 255)}.${random.int(1, 254)}`,
        wanIpAddress: `203.0.113.${random.int(1, 254)}`,
      },
    ],
    cpuInfo: [
      {
        model: cpu,
        architecture: 'x64',
        maxClockSpeedKhz: random.pick([2_800_000, 3_300_000, 3_400_000]),
        logicalCpus: Array.from({ length: cpus }, () => ({
          maxScalingFrequencyKhz: 2_800_000,
          currentScalingFrequencyKhz: random.int(800_000, 2_800_000),
          idleDuration: `${random.int(100, 90_000)}s`,
          cStates: [
            { displayName: 'C1', sessionDuration: `${random.int(10, 5_000)}s` },
          ],
        })),
      },
    ],
    diskSpaceUsage: {
      capacityBytes: String(device.storage_total),
      usedBytes: String(used),
    },
    tpmVersionInfo: {
      family: '322e3000',
      specLevel: '74',
      manufacturer: '49465800',
      tpmModel: '1',
      firmwareVersion: String(random.int(100_000, 999_999)),
      vendorSpecific: random.string(12, HEX),
    },
  };
}

export interface BatteryTelemetry {
  batteryInfo: Record<string, unknown>[];
  batteryStatusReport: Record<string, unknown>[];
}

/** Battery design data and 30 daily status reports, oldest first. */
export function batteryTelemetry(
  seed: string,
  device: StoredDevice,
): BatteryTelemetry | null {
  if (!device.has_battery || device.last_sync === null) return null;
  const random = createRandom(`battery/${seed}/${device.device_id}`);
  const design = MODEL_BY_NAME.get(device.model)?.designCapacity ?? 4000;
  const sync = device.last_sync;
  const ageYears = Math.max(0, (sync - device.first_enrollment_time) / YEAR_MS);
  const ratio = Math.min(
    1,
    Math.max(0.5, 1 - 0.045 * ageYears + random.normal() * 0.03),
  );
  const serialNumber = `${device.serial_number}B`;
  const cycles = Math.round(ageYears * 250);
  const made = new Date(device.first_enrollment_time - 60 * DAY_MS);
  return {
    batteryInfo: [
      {
        serialNumber,
        manufacturer: random.pick(['SMP', 'LGC', 'SDI', 'Celxpert']),
        designCapacity: String(design),
        designMinVoltage: random.pick([7600, 11250]),
        technology: 'Li-ion',
        manufactureDate: {
          year: made.getUTCFullYear(),
          month: made.getUTCMonth() + 1,
          day: made.getUTCDate(),
        },
      },
    ],
    batteryStatusReport: Array.from({ length: REPORT_DAYS }, (_, index) => {
      const daysAgo = REPORT_DAYS - 1 - index;
      const charge = Math.round(design * Math.min(1, ratio + 0.0004 * daysAgo));
      return {
        reportTime: iso(sync - daysAgo * DAY_MS - random.int(0, 3_600_000)),
        serialNumber,
        fullChargeCapacity: String(charge),
        cycleCount: Math.max(0, cycles - daysAgo),
        batteryHealth: batteryHealth(charge / design),
      };
    }),
  };
}
