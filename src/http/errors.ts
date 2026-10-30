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

/** The APIs that answer with the Google RPC error envelope. */
export function rpcEnvelope(api: Api): boolean {
  return api === 'chrome' || api === 'sheets';
}

/** The service that an error names in its `details`. */
const SERVICE: Record<string, string> = {
  chrome: 'chromemanagement.googleapis.com',
  drive: 'drive.googleapis.com',
  sheets: 'sheets.googleapis.com',
};

export function transientError(api: Api): ApiResponse {
  return rpcEnvelope(api)
    ? rpcError(503, 'UNAVAILABLE', 'The service is currently unavailable.')
    : directoryError(503, 'backendError', 'Backend Error');
}

export function internalError(api: Api): ApiResponse {
  return rpcEnvelope(api)
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

const SIGN_IN_HELP =
  'Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.';

/** 401 for a missing or unusable bearer token. */
export function unauthenticated(
  api: Api,
  kind: 'missing' | 'invalid',
): ApiResponse {
  const message =
    kind === 'missing'
      ? `Request is missing required authentication credential. ${SIGN_IN_HELP}`
      : `Request had invalid authentication credentials. ${SIGN_IN_HELP}`;
  if (rpcEnvelope(api)) return rpcError(401, 'UNAUTHENTICATED', message);
  return directoryError(
    401,
    kind === 'missing' ? 'required' : 'authError',
    message,
    {
      itemMessage:
        kind === 'missing' ? 'Login Required.' : 'Invalid Credentials',
      item: { location: 'Authorization', locationType: 'header' },
      extra: { status: 'UNAUTHENTICATED' },
    },
  );
}

/** 403 for a token without any accepted scope. */
export function insufficientScopes(api: Api): ApiResponse {
  const message = 'Request had insufficient authentication scopes.';
  const details = [
    {
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
      domain: 'googleapis.com',
      metadata: {
        service: SERVICE[api] ?? 'admin.googleapis.com',
      },
    },
  ];
  if (rpcEnvelope(api))
    return rpcError(403, 'PERMISSION_DENIED', message, details);
  return directoryError(403, 'insufficientPermissions', message, {
    itemMessage: 'Insufficient Permission',
    extra: { status: 'PERMISSION_DENIED', details },
  });
}

/** 403 for a subject without administrator rights or another customer's data. */
export function notAuthorized(api: Api): ApiResponse {
  return rpcEnvelope(api)
    ? rpcError(403, 'PERMISSION_DENIED', 'The caller does not have permission')
    : directoryError(
        403,
        'forbidden',
        'Not Authorized to access this resource/api',
      );
}

/** 400 for a request parameter that the mock cannot accept. */
export function invalidParameter(api: Api, message: string): ApiResponse {
  return rpcEnvelope(api)
    ? rpcError(400, 'INVALID_ARGUMENT', message)
    : directoryError(400, 'invalidParameter', message);
}

/** 404 for a Drive file that does not exist or that the token cannot see. */
export function driveNotFound(fileId: string): ApiResponse {
  const message = `File not found: ${fileId}.`;
  return directoryError(404, 'notFound', message, { itemMessage: message });
}

/** 404 for a spreadsheet that does not exist or that the token cannot see. */
export function sheetsNotFound(): ApiResponse {
  return rpcError(404, 'NOT_FOUND', 'Requested entity was not found.');
}

/** 403 for the media read of a Google Sheet, which holds no downloadable bytes. */
export function notDownloadable(): ApiResponse {
  return directoryError(
    403,
    'fileNotDownloadable',
    'Only files with binary content can be downloaded. Use Export with Docs Editors files.',
  );
}
