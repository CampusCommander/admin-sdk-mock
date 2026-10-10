import type { ApiResponse, Call } from '../http/types.ts';
import { createRandom } from '../random.ts';
import { row } from '../store/sqlite.ts';
import {
  commandState,
  settleCommands,
  type CommandRow,
} from './command-effects.ts';
import {
  domainOf,
  failedPrecondition,
  invalidArgument,
  iso,
  jsonBody,
  notFound,
  resolveCustomer,
} from './common.ts';
import { visibleDevice } from './devices.ts';

export const COMMAND_TYPES: ReadonlySet<string> = new Set([
  'REBOOT',
  'TAKE_A_SCREENSHOT',
  'SET_VOLUME',
  'WIPE_USERS',
  'REMOTE_POWERWASH',
  'DEVICE_START_CRD_SESSION',
  'CAPTURE_LOGS',
  'FETCH_CRD_AVAILABILITY_INFO',
  'FETCH_SUPPORT_PACKET',
]);

/** Ruling: a device synced within 24 hours is online. The window compares seeded timestamps, so it does not scale. */
const ONLINE_MS = 24 * 3_600_000;
const SUCCESS_RATE = 0.95;
const FAILURE_MESSAGE = 'The device failed to execute the command.';
const COMMAND_ID_BASE = 4_100_000_000;

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Validate the payload of a command. Only SET_VOLUME and DEVICE_START_CRD_SESSION take one. */
function payloadFor(call: Call, type: string, raw: unknown): string | null {
  const invalid = () => invalidArgument(call, 'Invalid Input: payload');
  if (raw === undefined || raw === null || raw === '') {
    if (type === 'SET_VOLUME') throw invalid();
    return null;
  }
  if (typeof raw !== 'string') throw invalid();
  if (type === 'SET_VOLUME') {
    const volume = parseObject(raw)?.volume;
    if (
      typeof volume !== 'number' ||
      !Number.isInteger(volume) ||
      volume < 0 ||
      volume > 100
    )
      throw invalid();
    return raw;
  }
  if (type === 'DEVICE_START_CRD_SESSION') {
    if (!parseObject(raw)) throw invalid();
    return raw;
  }
  throw invalidArgument(call, `Invalid Input: ${type} takes no payload.`);
}

/** `customer.devices.chromeos.issueCommand`. The response holds the new command ID. */
export function issueCommand(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  settleCommands(call);
  const device = visibleDevice(call, call.params.deviceId);
  const body = jsonBody(call);
  const type = body.commandType;
  if (typeof type !== 'string' || !COMMAND_TYPES.has(type))
    throw invalidArgument(call, 'Invalid Input: commandType');
  const payload = payloadFor(call, type, body.payload);
  if (device.status !== 'ACTIVE')
    throw failedPrecondition('The device must be active to receive a command.');
  const commandId = Number(
    row<{ next: number }>(
      domain.db
        .prepare(
          'SELECT COALESCE(MAX(command_id), ?) + 1 AS next FROM device_commands',
        )
        .get(COMMAND_ID_BASE),
    )!.next,
  );
  const random = createRandom(`command/${domain.spec.seed}/${commandId}`);
  const executeSeconds = random.int(10, 60);
  const success = random.chance(SUCCESS_RATE);
  const second = 1000 / call.scale;
  const online =
    device.last_sync !== null && call.now - device.last_sync <= ONLINE_MS;
  domain.db
    .prepare(
      'INSERT INTO device_commands (command_id, device_id, type, payload, issued_at, sent_at, acked_at, executed_at, expire_at, result, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      commandId,
      device.device_id,
      type,
      payload,
      call.now,
      online ? call.now + 2 * second : null,
      online ? call.now + 5 * second : null,
      online ? call.now + executeSeconds * second : null,
      call.now + domain.record.settings.writes.commandExpirySeconds * second,
      success ? 'SUCCESS' : 'FAILURE',
      success ? null : FAILURE_MESSAGE,
    );
  return { status: 200, items: 0, body: { commandId: String(commandId) } };
}

/** `customer.devices.chromeos.commands.get`. */
export function getCommand(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customerId);
  settleCommands(call);
  const device = visibleDevice(call, call.params.deviceId);
  const id = call.params.commandId;
  const command = /^\d+$/.test(id)
    ? row<CommandRow>(
        domain.db
          .prepare(
            'SELECT * FROM device_commands WHERE command_id = ? AND device_id = ?',
          )
          .get(Number(id), device.device_id),
      )
    : undefined;
  if (!command) throw notFound('commandId');
  const state = commandState(command, call.now);
  return {
    status: 200,
    items: 1,
    body: {
      commandId: String(command.command_id),
      type: command.type,
      issueTime: iso(command.issued_at),
      state,
      commandExpireTime: iso(command.expire_at),
      ...(command.payload ? { payload: command.payload } : {}),
      ...(state === 'EXECUTED_BY_CLIENT'
        ? {
            commandResult: {
              result: command.result,
              executeTime: iso(command.executed_at),
              ...(command.error_message
                ? { errorMessage: command.error_message }
                : {}),
            },
          }
        : {}),
    },
  };
}
