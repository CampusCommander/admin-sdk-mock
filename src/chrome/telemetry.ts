import { settleCommands } from '../directory/command-effects.ts';
import {
  invalidArgument,
  listedTable,
  domainOf,
  intParam,
  resolveCustomer,
} from '../directory/common.ts';
import { ApiError, rpcError } from '../http/errors.ts';
import type { ApiResponse, Call, OpenDomain } from '../http/types.ts';
import type { StoredDevice } from '../seed/devices.ts';
import { batteryTelemetry } from '../seed/reports.ts';
import {
  decodePageToken,
  encodePageToken,
  fingerprint,
} from '../store/page-token.ts';
import { whereClause } from '../store/sql.ts';
import { row, rows } from '../store/sqlite.ts';
import { FilterError, parseTelemetryFilter } from './telemetry-filter.ts';

function readMask(call: Call): Set<string> {
  const raw = call.request.query.get('readMask');
  const paths = (raw ?? '')
    .split(',')
    .map((path) => path.trim().split('.')[0])
    .filter(Boolean);
  if (paths.length === 0) throw invalidArgument(call, 'readMask is required');
  return new Set(paths);
}

/** Render the fields of one telemetry device that the read mask selects. */
export function telemetryDevice(
  device: StoredDevice,
  domain: OpenDomain,
  mask: ReadonlySet<string>,
  reportsFrom: number | null,
  recentReports: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (mask.has('name'))
    out.name = `customers/${domain.customerId}/telemetry/devices/${device.device_id}`;
  if (mask.has('customer')) out.customer = `customers/${domain.customerId}`;
  if (mask.has('orgUnitId'))
    out.orgUnitId = device.org_unit_id.replace(/^id:/, '');
  if (mask.has('deviceId')) out.deviceId = device.device_id;
  if (mask.has('serialNumber')) out.serialNumber = device.serial_number;
  if (mask.has('batteryInfo') || mask.has('batteryStatusReport')) {
    const battery = batteryTelemetry(domain.spec.seed, device);
    if (battery) {
      if (mask.has('batteryInfo')) out.batteryInfo = battery.batteryInfo;
      if (mask.has('batteryStatusReport')) {
        const reports =
          reportsFrom === null
            ? battery.batteryStatusReport.slice(-recentReports)
            : battery.batteryStatusReport.filter(
                (report) =>
                  Date.parse(String(report.reportTime)) >= reportsFrom,
              );
        if (reports.length > 0) out.batteryStatusReport = reports;
      }
    }
  }
  if (mask.has('memoryInfo'))
    out.memoryInfo = {
      totalRamBytes: String(device.ram_total),
      availableRamBytes: String(Math.round(device.ram_total * 0.4)),
    };
  if (mask.has('storageInfo'))
    out.storageInfo = {
      totalDiskBytes: String(device.storage_total),
      availableDiskBytes: String(Math.round(device.storage_total * 0.5)),
    };
  return out;
}

export function listTelemetry(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customer);
  settleCommands(call);
  const mask = readMask(call);
  const pageSize =
    intParam(call, 'pageSize', {
      fallback: 100,
      min: 0,
      max: 1000,
      clamp: true,
    }) || 100;
  let parsed;
  try {
    parsed = parseTelemetryFilter(call.request.query.get('filter') ?? '');
  } catch (error) {
    if (error instanceof FilterError)
      throw invalidArgument(call, error.message);
    throw error;
  }
  const filter = parsed.sql;
  const table = listedTable(call, 'devices');
  filter.where.push("status != 'DEPROVISIONED'");
  const hidden = [...call.overrides.hidden(domain.customerId)];
  if (hidden.length > 0) {
    filter.where.push(`device_id NOT IN (${hidden.map(() => '?').join(', ')})`);
    filter.params.push(...hidden);
  }
  const fp = fingerprint(
    call.request.path,
    call.request.query,
    domain.record.seededAt,
  );
  const pageToken = call.request.query.get('pageToken');
  if (pageToken) {
    let cursor: (string | number)[];
    try {
      cursor = decodePageToken(pageToken, fp, 1);
    } catch {
      throw invalidArgument(call, 'Invalid page token.');
    }
    filter.where.push('ord > ?');
    filter.params.push(cursor[0]);
  }
  const found = rows<StoredDevice>(
    domain.db
      .prepare(
        `SELECT * FROM ${table} ${whereClause(filter)} ORDER BY ord LIMIT ?`,
      )
      .all(...filter.params, pageSize + 1),
  );
  const page = found.slice(0, pageSize);
  const last = page.at(-1);
  const recent = domain.record.settings.telemetry.recentReports;
  const devices = page.map((device) =>
    telemetryDevice(device, domain, mask, parsed.reportsFrom, recent),
  );
  return {
    status: 200,
    items: page.length,
    body: {
      ...(devices.length > 0 ? { devices } : {}),
      ...(found.length > pageSize && last
        ? { nextPageToken: encodePageToken(fp, [last.ord]) }
        : {}),
    },
  };
}

export function getTelemetry(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customer);
  settleCommands(call);
  const mask = readMask(call);
  const id = call.params.deviceId;
  const device = call.overrides.hidden(domain.customerId).has(id)
    ? undefined
    : row<StoredDevice>(
        domain.db
          .prepare(
            "SELECT * FROM devices WHERE device_id = ? AND status != 'DEPROVISIONED'",
          )
          .get(id),
      );
  if (!device)
    throw new ApiError(
      rpcError(404, 'NOT_FOUND', 'Requested entity was not found.'),
    );
  return {
    status: 200,
    items: 1,
    body: telemetryDevice(
      device,
      domain,
      mask,
      null,
      domain.record.settings.telemetry.recentReports,
    ),
  };
}
