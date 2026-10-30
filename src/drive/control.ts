import type { OpenDomain } from '../http/types.ts';
import type { Mock } from '../mock.ts';
import { findUser } from '../store/user-lookup.ts';
import type { DriveRefusal } from '../store/registry.ts';
import {
  CSV_MIME,
  SHEET_MIME,
  type DriveFile,
  type FilePatch,
  type NewTab,
  type SheetTab,
  type TabPatch,
} from './store.ts';

/** A control request that the mock refuses. */
export class DriveControlError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DriveControlError';
    this.status = status;
  }
}

export interface ControlAnswer {
  status: number;
  body?: unknown;
}

type Json = Record<string, unknown>;

const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REFUSALS: readonly DriveRefusal[] = [
  'invalid_grant',
  'unauthorized_client',
];

const isJson = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function textOf(body: Json, name: string): string {
  const value = body[name];
  if (typeof value !== 'string')
    throw new DriveControlError(400, `${name} must be a string.`);
  return value;
}

function nameOf(body: Json, name: string): string {
  const value = textOf(body, name);
  if (value.length < 1 || value.length > 255)
    throw new DriveControlError(400, `${name} must be 1 to 255 characters.`);
  return value;
}

function countOf(body: Json, name: string): number | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new DriveControlError(
      400,
      `${name} must be a whole number of 1 or more.`,
    );
  return value;
}

function rowsOf(value: unknown): string[][] {
  if (!Array.isArray(value))
    throw new DriveControlError(400, 'rows must be a list of rows.');
  return value.map((row) => {
    if (!Array.isArray(row) || row.some((cell) => typeof cell !== 'string'))
      throw new DriveControlError(400, 'A row must be a list of strings.');
    return row as string[];
  });
}

function tabOf(value: unknown): NewTab {
  if (!isJson(value))
    throw new DriveControlError(400, 'A tab must be an object.');
  return {
    sheetId: countOf(value, 'sheetId'),
    title: value.title === undefined ? undefined : nameOf(value, 'title'),
    rows: value.rows === undefined ? undefined : rowsOf(value.rows),
    rowCount: countOf(value, 'rowCount'),
    columnCount: countOf(value, 'columnCount'),
    frozenRowCount: countOf(value, 'frozenRowCount'),
  };
}

function tabsOf(value: unknown): NewTab[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new DriveControlError(400, 'tabs must be a list of tabs.');
  return value.map(tabOf);
}

function patchOf(value: unknown): TabPatch {
  if (!isJson(value))
    throw new DriveControlError(400, 'A tab patch must be an object.');
  return {
    sheetId: countOf(value, 'sheetId'),
    title: value.title === undefined ? undefined : nameOf(value, 'title'),
    rows: value.rows === undefined ? undefined : rowsOf(value.rows),
  };
}

function tabView(tab: SheetTab): Json {
  return {
    sheetId: tab.sheetId,
    title: tab.title,
    index: tab.index,
    rowCount: tab.rowCount,
    columnCount: tab.columnCount,
    frozenRowCount: tab.frozenRowCount,
  };
}

/** The control API's view of a file. */
export function fileView(file: DriveFile): Json {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    owner: file.owner,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    granted: [...file.granted],
    ...(file.spreadsheet === null
      ? {}
      : { tabs: file.spreadsheet.tabs.map(tabView) }),
  };
}

/** The domain of a control route, which the caller has already checked. */
function domainOf(mock: Mock, customerId: string): OpenDomain {
  return mock.domains.get(customerId) as OpenDomain;
}

/** A subject of the domain, named by `field` in the body. */
function subjectOf(
  mock: Mock,
  customerId: string,
  body: Json,
  field: string,
): string {
  const named = nameOf(body, field);
  const user = findUser(domainOf(mock, customerId).db, named);
  if (!user)
    throw new DriveControlError(
      400,
      `${field} must name a user of the domain.`,
    );
  return user.primary_email;
}

function fileOf(mock: Mock, customerId: string, fileId: string): DriveFile {
  const file = mock.drive.file(customerId, fileId);
  if (!file) throw new DriveControlError(404, `File ${fileId} does not exist.`);
  return file;
}

/** Seed one file, in the Drive of one subject. */
function seed(mock: Mock, customerId: string, body: Json): ControlAnswer {
  const domain = domainOf(mock, customerId);
  const name = nameOf(body, 'name');
  const owner =
    body.owner === undefined
      ? `admin@${domain.spec.primaryDomain}`
      : subjectOf(mock, customerId, body, 'owner');
  const id = body.id === undefined ? undefined : nameOf(body, 'id');
  if (id !== undefined && !FILE_ID.test(id))
    throw new DriveControlError(
      400,
      'id must be 1 to 128 letters, digits, hyphens, or underscores.',
    );
  if (id !== undefined && mock.drive.file(customerId, id))
    throw new DriveControlError(409, `File ${id} exists.`);
  const tabs = body.tabs === undefined ? undefined : tabsOf(body.tabs);
  const content =
    body.content === undefined ? undefined : textOf(body, 'content');
  if (tabs !== undefined && content !== undefined)
    throw new DriveControlError(400, 'A file takes tabs or content, not both.');
  const mimeType =
    body.mimeType === undefined
      ? tabs
        ? SHEET_MIME
        : CSV_MIME
      : nameOf(body, 'mimeType');
  if (tabs !== undefined && mimeType !== SHEET_MIME)
    throw new DriveControlError(400, `tabs need the ${SHEET_MIME} type.`);
  const file = mock.drive.create(customerId, {
    id,
    name,
    mimeType,
    owner,
    content,
    tabs,
  });
  return { status: 201, body: fileView(file) };
}

/** Edit a file: its name, its media text, or the rows of one of its tabs. */
function edit(
  mock: Mock,
  customerId: string,
  fileId: string,
  body: Json,
): ControlAnswer {
  const file = fileOf(mock, customerId, fileId);
  const patch: FilePatch = {
    name: body.name === undefined ? undefined : nameOf(body, 'name'),
    content: body.content === undefined ? undefined : textOf(body, 'content'),
  };
  if (body.tabs !== undefined) {
    if (file.spreadsheet === null)
      throw new DriveControlError(
        400,
        'A file without tabs cannot take a tab patch.',
      );
    if (!Array.isArray(body.tabs))
      throw new DriveControlError(400, 'tabs must be a list of tab patches.');
    patch.tabs = body.tabs.map(patchOf);
  }
  return {
    status: 200,
    body: fileView(mock.drive.update(customerId, fileId, patch)),
  };
}

/** Add a tab to a spreadsheet. */
function addTab(
  mock: Mock,
  customerId: string,
  fileId: string,
  body: Json,
): ControlAnswer {
  const file = fileOf(mock, customerId, fileId);
  if (file.spreadsheet === null)
    throw new DriveControlError(400, `File ${fileId} is not a spreadsheet.`);
  const title = nameOf(body, 'title');
  if (file.spreadsheet.tabs.some((tab) => tab.title === title))
    throw new DriveControlError(409, `The spreadsheet holds a tab ${title}.`);
  const tab = mock.drive.addTab(customerId, fileId, { ...tabOf(body), title });
  return { status: 201, body: tabView(tab) };
}

/** Grant one subject the files of a person, as the Picker grants a picked file. */
function grant(
  mock: Mock,
  customerId: string,
  fileId: string,
  body: Json,
): ControlAnswer {
  const file = fileOf(mock, customerId, fileId);
  const subject = subjectOf(mock, customerId, body, 'subject');
  const granted = mock.drive.grant(customerId, fileId, subject);
  return {
    status: 200,
    body: { fileId: file.id, subjects: [...granted.granted] },
  };
}

/** Refuse, or allow again, the Drive token of one subject. */
function refusal(mock: Mock, customerId: string, body: Json): ControlAnswer {
  const subject = subjectOf(mock, customerId, body, 'subject');
  const error = nameOf(body, 'error');
  if (!REFUSALS.includes(error as DriveRefusal))
    throw new DriveControlError(
      400,
      `error must be one of: ${REFUSALS.join(', ')}.`,
    );
  mock.registry.setDriveRefusal(customerId, subject, error as DriveRefusal);
  return { status: 201, body: { subject, error } };
}

/**
 * Answer one control request below `/domains/{id}/drive`. The parts are the path segments
 * after `drive`. The caller has checked the domain and read the JSON body.
 */
export function handleDriveControl(
  mock: Mock,
  customerId: string,
  method: string,
  parts: readonly string[],
  body: Json,
): ControlAnswer {
  if (parts[0] === 'files') {
    if (parts.length === 1 && method === 'POST')
      return seed(mock, customerId, body);
    if (parts.length === 2 && method === 'PUT')
      return edit(mock, customerId, parts[1], body);
    if (parts.length === 2 && method === 'DELETE') {
      if (!mock.drive.remove(customerId, parts[1]))
        throw new DriveControlError(404, `File ${parts[1]} does not exist.`);
      return { status: 204 };
    }
    if (parts.length === 3 && parts[2] === 'tabs' && method === 'POST')
      return addTab(mock, customerId, parts[1], body);
    if (parts.length === 3 && parts[2] === 'grant' && method === 'POST')
      return grant(mock, customerId, parts[1], body);
  }
  if (parts.length === 1 && parts[0] === 'refusals') {
    if (method === 'POST') return refusal(mock, customerId, body);
    if (method === 'DELETE') {
      mock.registry.clearDriveRefusals(customerId);
      return { status: 204 };
    }
  }
  throw new DriveControlError(404, 'Not found.');
}
