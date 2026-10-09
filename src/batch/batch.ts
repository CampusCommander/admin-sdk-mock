import { randomBytes } from 'node:crypto';
import { directoryError } from '../http/errors.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import {
  BatchFormatError,
  buildBatchResponse,
  parseBatchRequest,
  type BatchPart,
  type BatchPartResult,
} from './multipart.ts';

export const MAX_BATCH_PARTS = 1000;
/** Parts that run at the same time inside one batch. */
export const BATCH_WAVE = 10;

export async function handleBatch(call: Call): Promise<ApiResponse> {
  const { request } = call;
  let parts: BatchPart[];
  try {
    parts = parseBatchRequest(
      request.headers['content-type'] ?? '',
      request.body,
    );
  } catch (error) {
    if (error instanceof BatchFormatError)
      return directoryError(400, 'badRequest', error.message);
    throw error;
  }
  if (parts.length === 0)
    return directoryError(
      400,
      'badRequest',
      'The batch request holds no parts.',
    );
  if (parts.length > MAX_BATCH_PARTS)
    return directoryError(
      400,
      'badRequest',
      `A batch request holds ${MAX_BATCH_PARTS} parts at most.`,
    );
  const results: BatchPartResult[] = new Array(parts.length);
  for (let start = 0; start < parts.length; start += BATCH_WAVE)
    await Promise.all(
      parts.slice(start, start + BATCH_WAVE).map(async (part, offset) => {
        const authorization =
          part.headers.authorization ?? request.headers.authorization;
        const response = await call.dispatchPart({
          method: part.method,
          host: 'admin.googleapis.com',
          path: part.path,
          query: part.query,
          headers: {
            ...part.headers,
            ...(authorization ? { authorization } : {}),
          },
          body: part.body,
        });
        results[start + offset] = {
          contentId: part.contentId,
          status: response.status,
          headers: {
            'Content-Type':
              response.headers?.['content-type'] ??
              'application/json; charset=UTF-8',
          },
          body: response.raw ?? '',
        };
      }),
    );
  const boundary = `batch_${randomBytes(12).toString('base64url')}`;
  return {
    status: 200,
    items: parts.length,
    headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
    raw: buildBatchResponse(results, boundary),
  };
}
