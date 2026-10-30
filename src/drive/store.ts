import { randomBytes } from 'node:crypto';
import type { Clock } from '../clock.ts';

/** The MIME type of a Google Sheet. */
export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
/** The MIME type of a CSV file. */
export const CSV_MIME = 'text/csv';
/** The rows of a tab that the caller does not size, as Google's default grid. */
export const DEFAULT_ROWS = 1_000;
/** The columns of a tab that the caller does not size. */
export const DEFAULT_COLUMNS = 26;

export interface NumberFormat {
  type: string;
  pattern?: string;
}

/** A number format over a rectangle of a tab. Indices start at 0 and the ends are exclusive. */
export interface GridFormat {
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
  numberFormat: NumberFormat;
}

export interface SheetTab {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
  columnCount: number;
  frozenRowCount: number;
  /** The cell text, row by row. A cell that a caller never wrote is an empty string. */
  rows: string[][];
  formats: GridFormat[];
}

export interface Spreadsheet {
  title: string;
  locale: string;
  timeZone: string;
  tabs: SheetTab[];
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** The subject whose Drive holds the file. */
  owner: string;
  createdTime: number;
  modifiedTime: number;
  /** The media bytes as UTF-8 text, or null for a Google Sheet. */
  content: string | null;
  /** The subjects that a control route granted. */
  granted: string[];
  spreadsheet: Spreadsheet | null;
}

export interface NewTab {
  sheetId?: number;
  title?: string;
  rows?: string[][];
  rowCount?: number;
  columnCount?: number;
  frozenRowCount?: number;
}

export interface NewFile {
  id?: string;
  name: string;
  mimeType: string;
  owner: string;
  content?: string;
  tabs?: NewTab[];
}

export interface TabPatch {
  sheetId?: number;
  title?: string;
  rows?: string[][];
}

export interface FilePatch {
  name?: string;
  content?: string;
  tabs?: TabPatch[];
}

export interface DriveStore {
  create(customerId: string, input: NewFile): DriveFile;
  file(customerId: string, fileId: string): DriveFile | undefined;
  /** The file, when this subject owns it or a control route granted it. */
  readable(
    customerId: string,
    subject: string,
    fileId: string,
  ): DriveFile | undefined;
  /** The files that this subject owns or holds a grant on, oldest first. */
  visible(customerId: string, subject: string): DriveFile[];
  update(customerId: string, fileId: string, patch: FilePatch): DriveFile;
  addTab(customerId: string, fileId: string, input: NewTab): SheetTab;
  /** Stamp a new modified time, for a write that the store did not make itself. */
  touch(customerId: string, fileId: string): void;
  remove(customerId: string, fileId: string): boolean;
  grant(customerId: string, fileId: string, subject: string): DriveFile;
  clear(customerId: string): void;
}

/** A new Google file ID, in the 44-character form that Drive uses. */
export function newFileId(): string {
  return randomBytes(33).toString('base64url');
}

/** The tab that a spreadsheet starts with. */
export function defaultTab(): SheetTab {
  return makeTab({ sheetId: 0, title: 'Sheet1', index: 0 });
}

/** Build a tab, with its grid at least as large as the rows that it holds. */
export function makeTab(input: NewTab & { index: number }): SheetTab {
  const rows = input.rows ?? [];
  const widest = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const tab: SheetTab = {
    sheetId: input.sheetId ?? 0,
    title: input.title ?? `Sheet${input.index + 1}`,
    index: input.index,
    rowCount: Math.max(1, input.rowCount ?? DEFAULT_ROWS, rows.length),
    columnCount: Math.max(1, input.columnCount ?? DEFAULT_COLUMNS, widest),
    frozenRowCount: input.frozenRowCount ?? 0,
    rows: [],
    formats: [],
  };
  writeRows(tab, 0, 0, rows);
  return tab;
}

/** Write cell text from a start cell, growing the grid so that it fits. */
export function writeRows(
  tab: SheetTab,
  startRow: number,
  startColumn: number,
  values: readonly (readonly string[])[],
): void {
  for (const [offset, row] of values.entries()) {
    const cells = tab.rows[startRow + offset] ?? [];
    for (const [column, text] of row.entries()) {
      const index = startColumn + column;
      while (cells.length < index) cells.push('');
      cells[index] = text;
    }
    tab.rows[startRow + offset] = cells;
  }
  tab.rowCount = Math.max(tab.rowCount, startRow + values.length);
  const width = values.reduce(
    (max, row) => Math.max(max, startColumn + row.length),
    0,
  );
  tab.columnCount = Math.max(tab.columnCount, width);
}

/** The text of a cell. A cell outside the data is empty. */
export function cellText(tab: SheetTab, row: number, column: number): string {
  return tab.rows[row]?.[column] ?? '';
}

/** The rows of a rectangle, each padded to the width of the rectangle. */
export function readRows(
  tab: SheetTab,
  startRow: number,
  endRow: number,
  startColumn: number,
  endColumn: number,
): string[][] {
  const rows: string[][] = [];
  for (let row = startRow; row < endRow; row++) {
    const cells: string[] = [];
    for (let column = startColumn; column < endColumn; column++)
      cells.push(cellText(tab, row, column));
    rows.push(cells);
  }
  return rows;
}

/** The last row that holds a value, or -1 for an empty tab. */
export function lastFilledRow(tab: SheetTab): number {
  for (let row = tab.rows.length - 1; row >= 0; row--)
    if ((tab.rows[row] ?? []).some((text) => text !== '')) return row;
  return -1;
}

/** The number format that covers a cell, or undefined when no format covers it. */
export function formatAt(
  tab: SheetTab,
  row: number,
  column: number,
): NumberFormat | undefined {
  let found: NumberFormat | undefined;
  for (const format of tab.formats)
    if (
      row >= format.startRowIndex &&
      row < format.endRowIndex &&
      column >= format.startColumnIndex &&
      column < format.endColumnIndex
    )
      found = format.numberFormat;
  return found;
}

/** The tab with this ID, or undefined. */
export function tabById(
  spreadsheet: Spreadsheet,
  sheetId: number,
): SheetTab | undefined {
  return spreadsheet.tabs.find((tab) => tab.sheetId === sheetId);
}

export function createDriveStore(deps: { clock: Clock }): DriveStore {
  const files = new Map<string, DriveFile[]>();
  const filesOf = (customerId: string) => files.get(customerId) ?? [];

  const find = (customerId: string, fileId: string) =>
    filesOf(customerId).find((file) => file.id === fileId);

  const touch = (file: DriveFile) => {
    file.modifiedTime = deps.clock.now();
  };

  const store: DriveStore = {
    create(customerId, input) {
      const now = deps.clock.now();
      const tabs = input.tabs?.length
        ? input.tabs
        : input.mimeType === SHEET_MIME
          ? [{}]
          : [];
      const spreadsheet =
        tabs.length === 0
          ? null
          : {
              title: input.name,
              locale: 'en_US',
              timeZone: 'UTC',
              tabs: tabs.map((tab, index) =>
                makeTab({ ...tab, index, sheetId: tab.sheetId ?? index }),
              ),
            };
      const file: DriveFile = {
        id: input.id ?? newFileId(),
        name: input.name,
        mimeType: input.mimeType,
        owner: input.owner,
        createdTime: now,
        modifiedTime: now,
        content: input.content ?? null,
        granted: [],
        spreadsheet,
      };
      files.set(customerId, [...filesOf(customerId), file]);
      return file;
    },
    file: find,
    readable(customerId, subject, fileId) {
      const file = find(customerId, fileId);
      if (!file) return undefined;
      return file.owner === subject || file.granted.includes(subject)
        ? file
        : undefined;
    },
    visible: (customerId, subject) =>
      filesOf(customerId).filter(
        (file) => file.owner === subject || file.granted.includes(subject),
      ),
    update(customerId, fileId, patch) {
      const file = find(customerId, fileId);
      if (!file) throw new Error(`No file ${fileId}.`);
      if (patch.name !== undefined) {
        file.name = patch.name;
        if (file.spreadsheet) file.spreadsheet.title = patch.name;
      }
      if (patch.content !== undefined) file.content = patch.content;
      for (const change of patch.tabs ?? []) {
        const tab = file.spreadsheet?.tabs.find(
          (candidate) =>
            (change.sheetId !== undefined &&
              candidate.sheetId === change.sheetId) ||
            (change.title !== undefined && candidate.title === change.title),
        );
        if (!tab) throw new Error(`No tab ${String(change.sheetId)}.`);
        if (change.title !== undefined) tab.title = change.title;
        if (change.rows !== undefined) {
          tab.rows = [];
          writeRows(tab, 0, 0, change.rows);
        }
      }
      touch(file);
      return file;
    },
    addTab(customerId, fileId, input) {
      const file = find(customerId, fileId);
      if (!file?.spreadsheet) throw new Error(`No spreadsheet ${fileId}.`);
      const index = file.spreadsheet.tabs.length;
      const sheetId = Math.max(
        0,
        ...file.spreadsheet.tabs.map((tab) => tab.sheetId + 1),
      );
      const tab = makeTab({
        ...input,
        sheetId: input.sheetId ?? sheetId,
        index,
      });
      file.spreadsheet.tabs.push(tab);
      touch(file);
      return tab;
    },
    remove(customerId, fileId) {
      const current = filesOf(customerId);
      const next = current.filter((file) => file.id !== fileId);
      files.set(customerId, next);
      return next.length !== current.length;
    },
    touch(customerId, fileId) {
      const file = find(customerId, fileId);
      if (!file) throw new Error(`No file ${fileId}.`);
      touch(file);
    },
    grant(customerId, fileId, subject) {
      const file = find(customerId, fileId);
      if (!file) throw new Error(`No file ${fileId}.`);
      if (!file.granted.includes(subject)) file.granted.push(subject);
      return file;
    },
    clear(customerId) {
      files.delete(customerId);
    },
  };
  return store;
}
