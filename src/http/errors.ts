import type { Api, ApiResponse } from './types.ts';

/** Throw from a handler to answer with a specific response. */
export class ApiError extends Error {
  readonly response: ApiResponse;
  constructor(response: ApiResponse) {
    super(`Google API error ${response.status}`);
    this.name = 'ApiError';
    this.response = response;
  }
}

export interface DirectoryErrorOptions {
  /** `errors[0].domain`. Defaults to `global`. */
  domain?: string;
  /** `errors[0].message` when it differs from the top message. */
  itemMessage?: string;
  /** Extra properties of `errors[0]`, such as `location`. */
  item?: Record<string, unknown>;
  /** Extra properties of `error`, such as `status` and `details`. */
  extra?: Record<string, unknown>;
}

/** The classic Directory API error envelope. */
export function directoryError(
  status: number,
  reason: string,
  message: string,
  options: DirectoryErrorOptions = {},
): ApiResponse {
  return {
    status,
    body: {
      error: {
        code: status,
        message,
        errors: [
          {
            message: options.itemMessage ?? message,
            domain: options.domain ?? 'global',
            reason,
            ...options.item,
          },
        ],
        ...options.extra,
      },
    },
  };
}

/** The Google RPC error envelope that Chrome Management uses. */
export function rpcError(
  status: number,
  rpcStatus: string,
  message: string,
  details?: unknown[],
): ApiResponse {
  return {
    status,
    body: {
      error: {
        code: status,
        message,
        status: rpcStatus,
        ...(details ? { details } : {}),
      },
    },
  };
}

export function transientError(api: Api): ApiResponse {
  return api === 'chrome'
    ? rpcError(503, 'UNAVAILABLE', 'The service is currently unavailable.')
    : directoryError(503, 'backendError', 'Backend Error');
}

export function internalError(api: Api): ApiResponse {
  return api === 'chrome'
    ? rpcError(500, 'INTERNAL', 'Internal error encountered.')
    : directoryError(500, 'backendError', 'Backend Error');
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** Google answers an unknown URL with an HTML page. */
export function notFoundPage(path: string): ApiResponse {
  return {
    status: 404,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
    raw: `<!DOCTYPE html>\n<html lang=en>\n  <meta charset=utf-8>\n  <title>Error 404 (Not Found)!!1</title>\n  <p><b>404.</b> <ins>That's an error.</ins>\n  <p>The requested URL <code>${escapeHtml(path)}</code> was not found on this server.  <ins>That's all we know.</ins>\n`,
  };
}
