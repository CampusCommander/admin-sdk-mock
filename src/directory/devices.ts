import { settleCommands } from './command-effects.ts';
import type { ApiResponse, Call, OpenDomain } from '../http/types.ts';
import type { StoredDevice } from '../seed/devices.ts';
import { deviceReports } from '../seed/reports.ts';
import {
  decodePageToken,
  encodePageToken,
  fingerprint,
} from '../store/page-token.ts';
import { emptyFilter, subtree, whereClause } from '../store/sql.ts';
import { row, rows } from '../store/sqlite.ts';
import {
  boolParam,
  domainOf,
  enumParam,
  intParam,
  invalidArgument,
  iso,
  listedTable,
  notFound,
  resolveCustomer,
  withEtag,
} from './common.ts';
import { parseDeviceQuery, QueryError } from './device-query.ts';
import { resolveOrgUnit } from './orgunits.ts';

const SORT = {
  ord: 'ord',
  annotatedLocation: "COALESCE(annotated_location, '')",
  annotatedUser: "COALESCE(annotated_user, '')",
  lastSync: 'COALESCE(last_sync, 0)',
  notes: "COALESCE(notes, '')",
  serialNumber: 'serial_number',
  status: 'status',
} as const;
type SortKey = keyof typeof SORT;

const ORDER_BY: Readonly<Record<string, SortKey>> = {
  annotatedlocation: 'annotatedLocation',
  annotateduser: 'annotatedUser',
  lastsync: 'lastSync',
  notes: 'notes',
  serialnumber: 'serialNumber',
  status: 'status',
};
const PROJECTION = { basic: 'BASIC', full: 'FULL' } as const;
const SORT_ORDER = { ascending: 'ASC', descending: 'DESC' } as const;

/** Render one stored device as a Directory API ChromeOsDevice. */
export function deviceResource(
  device: StoredDevice,
  projection: 'BASIC' | 'FULL',
  domain: OpenDomain,
): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    kind: 'admin#directory#chromeosdevice',
    deviceId: device.device_id,
    serialNumber: device.serial_number,
    status: device.status,
    lastSync: iso(device.last_sync),
    firstEnrollmentTime: iso(device.first_enrollment_time),
    lastEnrollmentTime: iso(device.last_enrollment_time),
    ...(device.annotated_user ? { annotatedUser: device.annotated_user } : {}),
    ...(device.annotated_location
      ? { annotatedLocation: device.annotated_location }
      : {}),
    ...(device.annotated_asset_id
      ? { annotatedAssetId: device.annotated_asset_id }
      : {}),
    ...(device.notes ? { notes: device.notes } : {}),
    model: device.model,
    ...(device.order_number ? { orderNumber: device.order_number } : {}),
    willAutoRenew: false,
    osVersion: device.os_version,
    platformVersion: device.platform_version,
    firmwareVersion: device.firmware_version,
    macAddress: device.mac_address,
    ...(device.ethernet_mac_address
      ? { ethernetMacAddress: device.ethernet_mac_address }
      : {}),
    bootMode: device.boot_mode,
    orgUnitPath: device.org_unit_path,
    orgUnitId: device.org_unit_id.replace(/^id:/, ''),
    autoUpdateExpiration: String(device.aue),
    autoUpdateThrough: iso(device.aue)!.slice(0, 10),
    osVersionCompliance:
      device.aue < domain.record.seededAt ? 'notCompliant' : 'compliant',
    deviceLicenseType: device.license_type,
    chromeOsType: 'chromeOs',
    systemRamTotal: String(device.ram_total),
    ...(device.deprovision_reason
      ? {
          deprovisionReason: device.deprovision_reason,
          lastDeprovisionTimestamp: iso(device.last_deprovision),
        }
      : {}),
  };
  if (projection === 'FULL' && device.status !== 'DEPROVISIONED')
    Object.assign(resource, deviceReports(domain.spec.seed, device));
  return withEtag(resource);
}

export function deviceCount(domain: OpenDomain): number {
  return Number(
    row<{ value: string }>(
      domain.db
        .prepare("SELECT value FROM meta WHERE key = 'deviceCount'")
        .get(),
    )?.value ?? 0,
  );
}

export function listDevices(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  settleCommands(call);
  const query = call.request.query;
  const maxResults = intParam(call, 'maxResults', {
    fallback: 100,
    min: 1,
    max: 300,
    clamp: true,
  });
  const projection = enumParam(call, 'projection', PROJECTION, 'FULL');
  const sortKey = enumParam<SortKey>(call, 'orderBy', ORDER_BY, 'ord');
  const descending = enumParam(call, 'sortOrder', SORT_ORDER, 'ASC') === 'DESC';
  const filter = emptyFilter();
  const devices = listedTable(call, 'devices');
  const units = listedTable(call, 'orgunits');

  const ouParam = query.get('orgUnitPath');
  const children = boolParam(call, 'includeChildOrgunits');
  if (children && !ouParam)
    throw invalidArgument(
      call,
      'orgUnitPath is required when includeChildOrgunits is true.',
    );
  if (ouParam) {
    const unit = resolveOrgUnit(call, domain.db, ouParam, units);
    if (children) subtree('org_unit_path', unit.path, filter);
    else {
      filter.where.push('org_unit_path = ?');
      filter.params.push(unit.path);
    }
  }
  const text = query.get('query');
  if (text) {
    try {
      const parsed = parseDeviceQuery(text);
      filter.where.push(...parsed.where);
      filter.params.push(...parsed.params);
    } catch (error) {
      if (error instanceof QueryError)
        throw invalidArgument(call, `Invalid Input: ${error.message}`);
      throw error;
    }
  }
  const hidden = [...call.overrides.hidden(domain.customerId)];
  if (hidden.length > 0) {
    filter.where.push(`device_id NOT IN (${hidden.map(() => '?').join(', ')})`);
    filter.params.push(...hidden);
  }

  const sort = SORT[sortKey];
  const fp = fingerprint(call.request.path, query, domain.record.seededAt);
  const pageToken = query.get('pageToken');
  if (pageToken) {
    let cursor: (string | number)[];
    try {
      cursor = decodePageToken(pageToken, fp, 2);
    } catch {
      throw invalidArgument(call, 'Invalid Input: pageToken');
    }
    filter.where.push(`(${sort}, device_id) ${descending ? '<' : '>'} (?, ?)`);
    filter.params.push(cursor[0], cursor[1]);
  }
  const direction = descending ? 'DESC' : 'ASC';
  const found = rows<StoredDevice & { sort_key: string | number }>(
    domain.db
      .prepare(
        `SELECT *, ${sort} AS sort_key FROM ${devices} ${whereClause(filter)} ORDER BY ${sort} ${direction}, device_id ${direction} LIMIT ?`,
      )
      .all(...filter.params, maxResults + 1),
  );
  const page = found.slice(0, maxResults);
  const last = page.at(-1);
  const nextPageToken =
    found.length > maxResults && last
      ? encodePageToken(fp, [last.sort_key, last.device_id])
      : undefined;
  const chromeosdevices = page.map((device) =>
    deviceResource(device, projection, domain),
  );
  return {
    status: 200,
    items: page.length,
    scanned: text ? deviceCount(domain) : 0,
    body: withEtag({
      kind: 'admin#directory#chromeosdevices',
      ...(chromeosdevices.length > 0 ? { chromeosdevices } : {}),
      ...(nextPageToken ? { nextPageToken } : {}),
    }),
  };
}

/** Find a device that requests may see. Unknown and hidden devices answer 404. */
export function visibleDevice(call: Call, id: string): StoredDevice {
  const domain = domainOf(call);
  const device = call.overrides.hidden(domain.customerId).has(id)
    ? undefined
    : row<StoredDevice>(
        domain.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(id),
      );
  if (!device) throw notFound('deviceId');
  return device;
}

export function getDevice(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  settleCommands(call);
  const projection = enumParam(call, 'projection', PROJECTION, 'FULL');
  const device = visibleDevice(call, call.params.deviceId);
  return {
    status: 200,
    items: 1,
    body: deviceResource(device, projection, domain),
  };
}
