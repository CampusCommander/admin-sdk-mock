import { ApiError, directoryError } from '../http/errors.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import type { StoredDevice } from '../seed/devices.ts';
import { saveBeforeImage, saveBeforeImagesWhere } from '../store/lag.ts';
import { row, rows, transaction } from '../store/sqlite.ts';
import {
  domainOf,
  enumParam,
  invalidArgument,
  jsonBody,
  resolveCustomer,
  searchDelayMs,
  stringField,
} from './common.ts';
import { deviceResource, visibleDevice } from './devices.ts';
import { targetOrgUnit } from './orgunits.ts';

export const MAX_DEVICE_IDS = 50;
const PROJECTION = { basic: 'BASIC', full: 'FULL' } as const;

/** Writable annotation fields, their columns, and their character limits. */
const ANNOTATIONS: readonly { field: string; column: string; max?: number }[] =
  [
    { field: 'annotatedUser', column: 'annotated_user', max: 100 },
    { field: 'annotatedLocation', column: 'annotated_location', max: 200 },
    { field: 'annotatedAssetId', column: 'annotated_asset_id' },
    { field: 'notes', column: 'notes', max: 500 },
  ];

/** Read `deviceIds`: 1 to 50 non-empty strings, in request order. */
export function deviceIdList(call: Call, value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((id) => typeof id === 'string' && id !== '')
  )
    throw invalidArgument(call, 'Invalid Input: deviceIds');
  if (value.length > MAX_DEVICE_IDS)
    throw invalidArgument(
      call,
      `Invalid Input: deviceIds holds more than ${MAX_DEVICE_IDS} devices.`,
    );
  return value as string[];
}

/** `chromeosdevices.update` and `chromeosdevices.patch`. Both change only the fields in the body. */
export function updateDevice(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  const projection = enumParam(call, 'projection', PROJECTION, 'FULL');
  const device = visibleDevice(call, call.params.deviceId);
  const body = jsonBody(call);
  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const { field, column, max } of ANNOTATIONS) {
    const value = stringField(call, body, field, max);
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(value === null || value === '' ? null : value);
  }
  const ouPath = stringField(call, body, 'orgUnitPath');
  const ouId = stringField(call, body, 'orgUnitId');
  const ouRaw =
    ouPath ?? (ouId ? (ouId.startsWith('id:') ? ouId : `id:${ouId}`) : null);
  if (ouRaw) {
    const unit = targetOrgUnit(call, ouRaw);
    sets.push('org_unit_path = ?', 'org_unit_id = ?');
    params.push(unit.path, unit.org_unit_id);
  }
  if (sets.length > 0)
    transaction(domain.db, () => {
      saveBeforeImage(
        domain.db,
        'devices',
        device.device_id,
        call.now,
        searchDelayMs(call),
      );
      domain.db
        .prepare(`UPDATE devices SET ${sets.join(', ')} WHERE device_id = ?`)
        .run(...params, device.device_id);
    });
  const updated = row<StoredDevice>(
    domain.db
      .prepare('SELECT * FROM devices WHERE device_id = ?')
      .get(device.device_id),
  )!;
  return {
    status: 200,
    items: 0,
    body: deviceResource(updated, projection, domain),
  };
}

/** `chromeosdevices.moveDevicesToOu`. One unknown device fails the whole request. */
export function moveDevicesToOu(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  const raw = call.request.query.get('orgUnitPath');
  if (!raw)
    throw new ApiError(
      directoryError(400, 'required', 'Required parameter: orgUnitPath'),
    );
  const unit = targetOrgUnit(call, raw);
  const ids = [...new Set(deviceIdList(call, jsonBody(call).deviceIds))];
  const marks = ids.map(() => '?').join(', ');
  const hidden = call.overrides.hidden(domain.customerId);
  const known = new Set(
    rows<{ device_id: string }>(
      domain.db
        .prepare(`SELECT device_id FROM devices WHERE device_id IN (${marks})`)
        .all(...ids),
    ).map((found) => found.device_id),
  );
  const unknown = ids.find((id) => !known.has(id) || hidden.has(id));
  if (unknown !== undefined)
    throw invalidArgument(call, `Invalid Input: deviceId ${unknown}`);
  transaction(domain.db, () => {
    saveBeforeImagesWhere(
      domain.db,
      'devices',
      `device_id IN (${marks})`,
      ids,
      call.now,
      searchDelayMs(call),
    );
    domain.db
      .prepare(
        `UPDATE devices SET org_unit_path = ?, org_unit_id = ? WHERE device_id IN (${marks})`,
      )
      .run(unit.path, unit.org_unit_id, ...ids);
  });
  return { status: 204, items: ids.length };
}
