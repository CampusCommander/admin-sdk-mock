import type { DatabaseSync } from 'node:sqlite';
import type { Call } from '../http/types.ts';
import { saveBeforeImage } from '../store/lag.ts';
import { rows, transaction } from '../store/sqlite.ts';
import { domainOf, searchDelayMs } from './common.ts';

/** One row of the `device_commands` table. */
export interface CommandRow {
  command_id: number;
  device_id: string;
  type: string;
  payload: string | null;
  issued_at: number;
  sent_at: number | null;
  acked_at: number | null;
  executed_at: number | null;
  expire_at: number;
  result: string;
  error_message: string | null;
  applied: number;
}

/** A command executes only when its execution time comes before its expiry. */
const executes = (command: CommandRow): boolean =>
  command.executed_at !== null && command.executed_at <= command.expire_at;

/** The state of a command at a time. */
export function commandState(command: CommandRow, now: number): string {
  if (executes(command) && now >= command.executed_at!)
    return 'EXECUTED_BY_CLIENT';
  if (now >= command.expire_at) return 'EXPIRED';
  if (command.acked_at !== null && now >= command.acked_at)
    return 'ACKED_BY_CLIENT';
  if (command.sent_at !== null && now >= command.sent_at)
    return 'SENT_TO_CLIENT';
  return 'PENDING';
}

const EFFECTS: Readonly<
  Record<string, (command: CommandRow) => [string, (string | number)[]]>
> = {
  REBOOT: (command) => [
    'UPDATE devices SET last_sync = ? WHERE device_id = ?',
    [command.executed_at!, command.device_id],
  ],
  WIPE_USERS: (command) => [
    'UPDATE devices SET recent_users = NULL WHERE device_id = ?',
    [command.device_id],
  ],
  REMOTE_POWERWASH: (command) => [
    'UPDATE devices SET recent_users = NULL WHERE device_id = ?',
    [command.device_id],
  ],
};

/**
 * Apply the side effects of every successful command that has executed by `now`.
 * Each side effect is a write stamped at its execution time.
 * A delay of 0 saves no before-images, so effects show in lists at once.
 * Callers must not hold an open transaction, because `transaction()` cannot nest.
 */
export function settleDueCommands(
  db: DatabaseSync,
  now: number,
  delayMs: number,
): void {
  const due = rows<CommandRow>(
    db
      .prepare(
        'SELECT * FROM device_commands WHERE applied = 0 AND executed_at IS NOT NULL AND executed_at <= ? AND executed_at <= expire_at ORDER BY executed_at, command_id',
      )
      .all(now),
  );
  if (due.length === 0) return;
  transaction(db, () => {
    for (const command of due) {
      const effect = EFFECTS[command.type];
      if (effect && command.result === 'SUCCESS') {
        saveBeforeImage(
          db,
          'devices',
          command.device_id,
          command.executed_at!,
          delayMs,
        );
        const [sql, params] = effect(command);
        db.prepare(sql).run(...params);
      }
      db.prepare(
        'UPDATE device_commands SET applied = 1 WHERE command_id = ?',
      ).run(command.command_id);
    }
  });
}

/**
 * Apply the due command side effects of a call's domain at the call time.
 * Run this before any handler reads or writes device rows.
 * Callers must not hold an open transaction, because `transaction()` cannot nest.
 */
export function settleCommands(call: Call): void {
  settleDueCommands(domainOf(call).db, call.now, searchDelayMs(call));
}
