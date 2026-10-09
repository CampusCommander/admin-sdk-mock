import { DatabaseSync } from 'node:sqlite';

/** Open a SQLite file with write-ahead logging and foreign keys on. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
  );
  return db;
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Type the rows that `node:sqlite` returns. */
export function rows<T>(value: unknown): T[] {
  return value as T[];
}

export function row<T>(value: unknown): T | undefined {
  return value as T | undefined;
}
