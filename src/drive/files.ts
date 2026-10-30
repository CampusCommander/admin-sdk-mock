import {
  ApiError,
  driveNotFound,
  invalidParameter,
  notDownloadable,
} from '../http/errors.ts';
import type { Access, ApiResponse, Call } from '../http/types.ts';
import type { Mock } from '../mock.ts';
import type { DriveFile } from './store.ts';

/** The access of a route that the dispatcher authenticates. */
export const accessOf = (call: Call): Access => call.access as Access;

/** The Drive resource of a file. A Google Sheet carries no size and no link. */
export function fileJson(
  file: DriveFile,
  subject: string,
): Record<string, unknown> {
  return {
    kind: 'drive#file',
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    createdTime: new Date(file.createdTime).toISOString(),
    modifiedTime: new Date(file.modifiedTime).toISOString(),
    ownedByMe: file.owner === subject,
    shared: file.granted.length > 0,
    trashed: false,
    ...(file.content === null
      ? {}
      : { size: String(Buffer.byteLength(file.content)) }),
  };
}

/** The page size of a list request. A value above 1,000 clamps. */
function pageSizeOf(call: Call): number {
  const text = call.request.query.get('pageSize');
  if (text === null || text === '') return 100;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1)
    throw new ApiError(
      invalidParameter(
        call.route.api,
        'The pageSize must be a whole number from 1 to 1000.',
      ),
    );
  return Math.min(value, 1_000);
}

/** The offset that a page token carries. */
function offsetOf(call: Call): number {
  const text = call.request.query.get('pageToken');
  if (text === null || text === '') return 0;
  const offset = Number(Buffer.from(text, 'base64url').toString('utf8'));
  if (!Number.isInteger(offset) || offset < 0)
    throw new ApiError(invalidParameter(call.route.api, 'Invalid page token.'));
  return offset;
}

/** List the files that the token's subject owns or holds a grant on. */
export function listFiles(mock: Mock, call: Call): ApiResponse {
  const access = accessOf(call);
  const pageSize = pageSizeOf(call);
  const offset = offsetOf(call);
  const all = mock.drive.visible(access.customerId, access.subject);
  const page = all.slice(offset, offset + pageSize);
  const next = offset + pageSize < all.length ? offset + pageSize : null;
  return {
    status: 200,
    body: {
      kind: 'drive#fileList',
      incompleteSearch: false,
      files: page.map((file) => fileJson(file, access.subject)),
      ...(next === null
        ? {}
        : { nextPageToken: Buffer.from(String(next)).toString('base64url') }),
    },
    items: page.length,
  };
}

/** The metadata of one file. */
export function getFile(mock: Mock, call: Call): ApiResponse {
  const access = accessOf(call);
  const file = mock.drive.readable(
    access.customerId,
    access.subject,
    call.params.fileId,
  );
  if (!file) return driveNotFound(call.params.fileId);
  return { status: 200, body: fileJson(file, access.subject) };
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Read a `Range` header against a body of `size` bytes. A header that the mock cannot
 * read is ignored, as HTTP allows. A start past the end is unsatisfiable.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfied' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0) return 'unsatisfied';
    return { start: Math.max(0, size - suffix), end: Math.max(0, size - 1) };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfied';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return 'unsatisfied';
  return { start, end };
}

/** The media read of a file. It looks the file up after the pipeline faults run. */
export function getMedia(mock: Mock, call: Call): ApiResponse {
  const access = accessOf(call);
  const file = mock.drive.readable(
    access.customerId,
    access.subject,
    call.params.fileId,
  );
  if (!file) return driveNotFound(call.params.fileId);
  if (file.content === null) return notDownloadable();
  const bytes = Buffer.from(file.content, 'utf8');
  const size = bytes.length;
  const range = parseRange(call.request.headers.range, size);
  if (range === 'unsatisfied')
    return {
      status: 416,
      raw: '',
      headers: { 'content-range': `bytes */${size}` },
    };
  const headers: Record<string, string> = {
    'content-type': file.mimeType,
    'accept-ranges': 'bytes',
  };
  if (range === null)
    return {
      status: 200,
      raw: file.content,
      headers: { ...headers, 'content-length': String(size) },
    };
  const slice = bytes.subarray(range.start, range.end + 1);
  return {
    status: 206,
    raw: slice.toString('utf8'),
    headers: {
      ...headers,
      'content-length': String(slice.length),
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
    },
  };
}
