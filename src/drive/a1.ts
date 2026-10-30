import type { SheetTab } from './store.ts';

/** A range that the mock cannot read. */
export class A1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A1Error';
  }
}

/** A rectangle of a tab. Rows and columns start at 0 and `end` is exclusive. */
export interface A1Range {
  tab: SheetTab;
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
  /** Whether the request named no end cell, so the data decides the end. */
  open: boolean;
}

interface Cell {
  column: number | null;
  row: number | null;
}

const CELL = /^([A-Za-z]*)(\d*)$/;

/** The 0-based index of a column named by letters: A is 0, Z is 25, AA is 26. */
export function columnIndex(letters: string): number {
  let index = 0;
  for (const character of letters.toUpperCase())
    index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

/** The letters of a 0-based column index. */
export function columnName(index: number): string {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

/** Remove one pair of single quotes from a tab title. */
function unquote(text: string): string {
  return text.length >= 2 && text.startsWith("'") && text.endsWith("'")
    ? text.slice(1, -1).replaceAll("''", "'")
    : text;
}

/** The tab title as an A1 reference writes it. */
export function quotedTitle(title: string): string {
  return /^[A-Za-z0-9_]+$/.test(title)
    ? title
    : `'${title.replaceAll("'", "''")}'`;
}

/** The A1 text of a rectangle that ends at an exclusive row and column. */
export function rangeText(
  tab: SheetTab,
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
): string {
  const lastRow = Math.max(startRow + 1, endRow);
  const lastColumn = Math.max(startColumn, endColumn - 1);
  return `${quotedTitle(tab.title)}!${columnName(startColumn)}${startRow + 1}:${columnName(lastColumn)}${lastRow}`;
}

function cellOf(text: string, whole: string): Cell {
  const match = CELL.exec(text);
  if (!match || (match[1] === '' && match[2] === ''))
    throw new A1Error(`Unable to parse range: ${whole}`);
  const column = match[1] === '' ? null : columnIndex(match[1]);
  const row = match[2] === '' ? null : Number(match[2]) - 1;
  if (row !== null && row < 0)
    throw new A1Error(`Unable to parse range: ${whole}`);
  return { column, row };
}

/**
 * Read an A1 range against the tabs of a spreadsheet. The tab title before `!` may be
 * quoted. A range without a title reads the first tab. A range without a cell reads the
 * whole tab. A range with one cell reads that cell alone.
 */
export function parseA1(tabs: readonly SheetTab[], text: string): A1Range {
  const bang = text.indexOf('!');
  const named = bang === -1 ? null : unquote(text.slice(0, bang));
  let cells = bang === -1 ? text : text.slice(bang + 1);
  let tab: SheetTab | undefined;
  if (named === null) {
    const titled = tabs.find((candidate) => candidate.title === text);
    tab = titled ?? tabs[0];
    if (titled) cells = '';
  } else {
    tab = tabs.find((candidate) => candidate.title === named);
  }
  if (!tab) throw new A1Error(`Unable to parse range: ${text}`);
  if (cells === '')
    return {
      tab,
      startRow: 0,
      endRow: tab.rowCount,
      startColumn: 0,
      endColumn: tab.columnCount,
      open: true,
    };
  const [firstText, lastText, ...rest] = cells.split(':');
  if (rest.length > 0) throw new A1Error(`Unable to parse range: ${text}`);
  const first = cellOf(firstText, text);
  if (lastText === undefined)
    return {
      tab,
      startRow: first.row ?? 0,
      endRow: first.row === null ? tab.rowCount : first.row + 1,
      startColumn: first.column ?? 0,
      endColumn: first.column === null ? tab.columnCount : first.column + 1,
      open: first.row === null || first.column === null,
    };
  const last = cellOf(lastText, text);
  const startRow = first.row ?? 0;
  const startColumn = first.column ?? 0;
  const endRow = last.row === null ? tab.rowCount : last.row + 1;
  const endColumn = last.column === null ? tab.columnCount : last.column + 1;
  if (endRow <= startRow || endColumn <= startColumn)
    throw new A1Error(`Unable to parse range: ${text}`);
  return {
    tab,
    startRow,
    endRow,
    startColumn,
    endColumn,
    open: last.row === null || last.column === null,
  };
}
