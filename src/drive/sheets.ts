import { ApiError, rpcError, sheetsNotFound } from '../http/errors.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import type { Mock } from '../mock.ts';
import { A1Error, parseA1, rangeText, type A1Range } from './a1.ts';
import { accessOf } from './files.ts';
import {
  formatAt,
  lastFilledRow,
  readRows,
  SHEET_MIME,
  writeRows,
  type DriveFile,
  type NewTab,
  type SheetTab,
  type Spreadsheet,
} from './store.ts';

type Json = Record<string, unknown>;

/** Answer a request that the mock cannot read as Google answers a bad argument. */
function fail(message: string): never {
  throw new ApiError(rpcError(400, 'INVALID_ARGUMENT', message));
}

function isJson(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value: unknown, name: string): Json {
  if (!isJson(value))
    fail(`Invalid JSON payload received. The ${name} field must be an object.`);
  return value;
}

function optionalObject(value: unknown): Json {
  return isJson(value) ? value : {};
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value))
    fail(`Invalid JSON payload received. The ${name} field must be a list.`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '')
    fail(
      `Invalid JSON payload received. The ${name} field must be a non-empty string.`,
    );
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    fail('Invalid JSON payload received. A grid index must be a whole number.');
  return value;
}

/** The request body, which must be a JSON object. */
function bodyOf(call: Call): Json {
  if (call.request.body.trim() === '')
    fail('Invalid JSON payload received. The request body is empty.');
  let value: unknown;
  try {
    value = JSON.parse(call.request.body);
  } catch {
    fail('Invalid JSON payload received. The body is not valid JSON.');
  }
  return requireObject(value, 'body');
}

/** The cell text of one `RowData`. */
function rowValues(value: unknown): string[] {
  const row = requireObject(value, 'rowData');
  const values =
    row.values === undefined ? [] : requireArray(row.values, 'rowData.values');
  return values.map((cell) => {
    const data = optionalObject(cell);
    const entered = optionalObject(data.userEnteredValue);
    const text = entered.stringValue;
    return typeof text === 'string' ? text : '';
  });
}

/** The rows that a `GridData` list holds, placed at their start cells. */
function gridRows(data: unknown[]): string[][] {
  const rows: string[][] = [];
  for (const [index, block] of data.entries()) {
    const grid = requireObject(block, `sheets[].data[${index}]`);
    const startRow = optionalInteger(grid.startRow) ?? 0;
    const startColumn = optionalInteger(grid.startColumn) ?? 0;
    const rowData =
      grid.rowData === undefined ? [] : requireArray(grid.rowData, 'rowData');
    for (const [offset, entry] of rowData.entries()) {
      const cells = rowValues(entry);
      const target = rows[startRow + offset] ?? [];
      for (const [column, text] of cells.entries()) {
        const at = startColumn + column;
        while (target.length < at) target.push('');
        target[at] = text;
      }
      rows[startRow + offset] = target;
    }
  }
  for (let index = 0; index < rows.length; index++)
    rows[index] = rows[index] ?? [];
  return rows;
}

/** One tab of a `spreadsheets.create` body. */
function tabRequest(value: unknown, index: number): NewTab {
  const sheet = requireObject(value, `sheets[${index}]`);
  const properties = optionalObject(sheet.properties);
  const grid = optionalObject(properties.gridProperties);
  const title = properties.title;
  return {
    sheetId: optionalInteger(properties.sheetId),
    title:
      title === undefined
        ? undefined
        : requireString(title, 'sheets[].properties.title'),
    rowCount: optionalInteger(grid.rowCount),
    columnCount: optionalInteger(grid.columnCount),
    frozenRowCount: optionalInteger(grid.frozenRowCount),
    rows:
      sheet.data === undefined
        ? undefined
        : gridRows(requireArray(sheet.data, 'sheets[].data')),
  };
}

function tabProperties(tab: SheetTab): Json {
  return {
    sheetId: tab.sheetId,
    title: tab.title,
    index: tab.index,
    sheetType: 'GRID',
    gridProperties: {
      rowCount: tab.rowCount,
      columnCount: tab.columnCount,
      ...(tab.frozenRowCount > 0 ? { frozenRowCount: tab.frozenRowCount } : {}),
    },
  };
}

function cellJson(
  tab: SheetTab,
  row: number,
  column: number,
  text: string,
): Json {
  const format = formatAt(tab, row, column);
  return {
    ...(text === ''
      ? {}
      : { formattedValue: text, userEnteredValue: { stringValue: text } }),
    ...(format === undefined
      ? {}
      : { userEnteredFormat: { numberFormat: format } }),
  };
}

/** The cell data of a tab, to the last row and column that hold a value. */
function gridData(tab: SheetTab): Json {
  const last = lastFilledRow(tab);
  const rowData: Json[] = [];
  for (let row = 0; row <= last; row++)
    rowData.push({
      values: (tab.rows[row] ?? []).map((text, column) =>
        cellJson(tab, row, column, text),
      ),
    });
  return { startRow: 0, startColumn: 0, rowData };
}

function spreadsheetOf(file: DriveFile): Spreadsheet {
  return file.spreadsheet as Spreadsheet;
}

/** The `Spreadsheet` resource. */
export function spreadsheetJson(file: DriveFile, grid: boolean): Json {
  const spreadsheet = spreadsheetOf(file);
  return {
    spreadsheetId: file.id,
    properties: {
      title: spreadsheet.title,
      locale: spreadsheet.locale,
      timeZone: spreadsheet.timeZone,
      autoRecalc: 'ON_CHANGE',
    },
    sheets: spreadsheet.tabs.map((tab) => ({
      properties: tabProperties(tab),
      ...(grid ? { data: [gridData(tab)] } : {}),
    })),
  };
}

/** The spreadsheet of a request, or a 404 answer. */
function spreadsheetOfCall(mock: Mock, call: Call): DriveFile | undefined {
  const access = accessOf(call);
  const file = mock.drive.readable(
    access.customerId,
    access.subject,
    call.params.spreadsheetId,
  );
  return file?.spreadsheet ? file : undefined;
}

/** Create a spreadsheet in the token subject's Drive. */
export function createSpreadsheet(mock: Mock, call: Call): ApiResponse {
  const access = accessOf(call);
  const body = bodyOf(call);
  const properties = optionalObject(body.properties);
  const title = requireString(properties.title, 'properties.title');
  const sheets =
    body.sheets === undefined ? [] : requireArray(body.sheets, 'sheets');
  const file = mock.drive.create(access.customerId, {
    name: title,
    mimeType: SHEET_MIME,
    owner: access.subject,
    ...(sheets.length === 0 ? {} : { tabs: sheets.map(tabRequest) }),
  });
  return { status: 200, body: spreadsheetJson(file, false), items: 1 };
}

/** The spreadsheet and its tabs. `includeGridData` adds the cell data. */
export function getSpreadsheet(mock: Mock, call: Call): ApiResponse {
  const file = spreadsheetOfCall(mock, call);
  if (!file) return sheetsNotFound();
  return {
    status: 200,
    body: spreadsheetJson(
      file,
      call.request.query.get('includeGridData') === 'true',
    ),
    items: 1,
  };
}

/** Apply one `repeatCell` request to a sheet's formats. */
function repeatCell(spreadsheet: Spreadsheet, value: unknown): Json {
  const repeat = requireObject(value, 'repeatCell');
  const range = requireObject(repeat.range, 'repeatCell.range');
  const sheetId = optionalInteger(range.sheetId);
  if (sheetId === undefined)
    fail(
      'Invalid JSON payload received. repeatCell.range.sheetId is required.',
    );
  const tab = spreadsheet.tabs.find(
    (candidate) => candidate.sheetId === sheetId,
  );
  if (!tab) fail(`No sheet with ID ${String(sheetId)}.`);
  const cell = optionalObject(repeat.cell);
  const entered = optionalObject(cell.userEnteredFormat);
  const numberFormat = requireObject(
    entered.numberFormat,
    'repeatCell.cell.userEnteredFormat.numberFormat',
  );
  const type = requireString(numberFormat.type, 'numberFormat.type');
  const pattern = numberFormat.pattern;
  tab.formats.push({
    startRowIndex: optionalInteger(range.startRowIndex) ?? 0,
    endRowIndex: optionalInteger(range.endRowIndex) ?? tab.rowCount,
    startColumnIndex: optionalInteger(range.startColumnIndex) ?? 0,
    endColumnIndex: optionalInteger(range.endColumnIndex) ?? tab.columnCount,
    numberFormat: {
      type,
      ...(typeof pattern === 'string' ? { pattern } : {}),
    },
  });
  return {};
}

/** Apply a batch of requests. The mock supports `repeatCell` alone. */
export function batchUpdate(mock: Mock, call: Call): ApiResponse {
  const file = spreadsheetOfCall(mock, call);
  if (!file) return sheetsNotFound();
  const body = bodyOf(call);
  const requests = requireArray(body.requests, 'requests');
  const replies = requests.map((request) => {
    if (!isJson(request) || repeatKeyOf(request) !== 'repeatCell')
      fail('The mock supports the repeatCell request only.');
    return repeatCell(spreadsheetOf(file), request.repeatCell);
  });
  return {
    status: 200,
    body: { spreadsheetId: file.id, replies },
    items: replies.length,
  };
}

function repeatKeyOf(request: Json): string | undefined {
  return Object.keys(request).find((key) => isJson(request[key]));
}

/** The range of a request, as a 400 answer when the mock cannot read it. */
function rangeOf(spreadsheet: Spreadsheet, text: string): A1Range {
  try {
    return parseA1(spreadsheet.tabs, text);
  } catch (error) {
    if (error instanceof A1Error) fail(error.message);
    throw error;
  }
}

/** Drop trailing empty rows, then trailing empty columns. */
export function trimEmpty(matrix: string[][]): string[][] {
  const rows = matrix.map((row) => [...row]);
  while (rows.length > 0 && rows[rows.length - 1].every((text) => text === ''))
    rows.pop();
  let width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  while (width > 0 && rows.every((row) => (row[width - 1] ?? '') === ''))
    width--;
  return rows.map((row) => row.slice(0, width));
}

/** Read formatted values from a tab. */
export function getValues(mock: Mock, call: Call): ApiResponse {
  const file = spreadsheetOfCall(mock, call);
  if (!file) return sheetsNotFound();
  const option = call.request.query.get('valueRenderOption');
  if (
    option !== null &&
    !['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'].includes(option)
  )
    fail(`Unknown valueRenderOption ${option}.`);
  const major = call.request.query.get('majorDimension');
  if (major !== null && !['ROWS', 'COLUMNS'].includes(major))
    fail(`Unknown majorDimension ${major}.`);
  const spreadsheet = spreadsheetOf(file);
  const range = rangeOf(spreadsheet, call.params.range);
  const tab = range.tab;
  const endRow = range.open
    ? Math.min(range.endRow, lastFilledRow(tab) + 1)
    : range.endRow;
  const matrix = trimEmpty(
    readRows(
      tab,
      range.startRow,
      Math.max(range.startRow, endRow),
      range.startColumn,
      range.endColumn,
    ),
  );
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  const rows =
    major === 'COLUMNS'
      ? Array.from({ length: width }, (_, column) =>
          matrix.map((row) => row[column] ?? ''),
        )
      : matrix;
  return {
    status: 200,
    body: {
      range: rangeText(
        tab,
        range.startRow,
        range.startColumn,
        range.startRow + Math.max(1, matrix.length),
        range.startColumn + Math.max(1, width),
      ),
      majorDimension: major ?? 'ROWS',
      ...(rows.length === 0 ? {} : { values: rows }),
    },
    items: rows.length,
  };
}

/** Write `RAW` values into a tab. The grid grows to hold them. */
export function updateValues(mock: Mock, call: Call): ApiResponse {
  const access = accessOf(call);
  const file = spreadsheetOfCall(mock, call);
  if (!file) return sheetsNotFound();
  const option = call.request.query.get('valueInputOption');
  if (option === null)
    fail('Invalid JSON payload received. valueInputOption is required.');
  if (option !== 'RAW') fail('The mock supports valueInputOption RAW only.');
  const body = bodyOf(call);
  const values =
    body.values === undefined
      ? []
      : requireArray(body.values, 'values').map((row) =>
          requireArray(row, 'values[]').map((cell) =>
            cell === null || cell === undefined ? '' : String(cell),
          ),
        );
  const spreadsheet = spreadsheetOf(file);
  const range = rangeOf(spreadsheet, call.params.range);
  const tab = range.tab;
  writeRows(tab, range.startRow, range.startColumn, values);
  mock.drive.touch(access.customerId, file.id);
  const width = values.reduce((max, row) => Math.max(max, row.length), 0);
  return {
    status: 200,
    body: {
      spreadsheetId: file.id,
      updatedRange: rangeText(
        tab,
        range.startRow,
        range.startColumn,
        range.startRow + Math.max(1, values.length),
        range.startColumn + Math.max(1, width),
      ),
      updatedRows: values.length,
      updatedColumns: width,
      updatedCells: values.reduce((total, row) => total + row.length, 0),
    },
    items: values.length,
  };
}
