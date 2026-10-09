import { STATUS_CODES } from 'node:http';

export interface BatchPart {
  contentId: string | null;
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
}

export interface BatchPartResult {
  contentId: string | null;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class BatchFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchFormatError';
  }
}

function splitHead(text: string): [string, string] {
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return [text, ''];
  return [
    text.slice(0, match.index),
    text.slice(match.index + match[0].length),
  ];
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
  }
  return headers;
}

/** Parse a multipart/mixed batch body into its HTTP requests. */
export function parseBatchRequest(
  contentType: string,
  body: string,
): BatchPart[] {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!/^multipart\/mixed/i.test(contentType.trim()) || !boundary)
    throw new BatchFormatError(
      'A batch request needs a multipart/mixed content type with a boundary.',
    );
  const sections = body.split(`--${boundary}`);
  const parts: BatchPart[] = [];
  for (let index = 1; index < sections.length; index++) {
    const section = sections[index];
    if (section.startsWith('--')) break;
    const text = section.replace(/^\r?\n/, '');
    if (text.trim() === '') continue;
    const [outer, rest] = splitHead(text);
    const [head, requestBody] = splitHead(rest);
    const [requestLine, ...headerLines] = head.split(/\r?\n/);
    const line = /^([A-Z]+)\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?$/.exec(
      requestLine.trim(),
    );
    if (!line)
      throw new BatchFormatError(
        `Batch part ${index} has an invalid request line.`,
      );
    const url = new URL(line[2], 'https://admin.googleapis.com');
    parts.push({
      contentId:
        (parseHeaders(outer)['content-id'] ?? '').replace(/^<|>$/g, '') || null,
      method: line[1],
      host: url.hostname,
      path: url.pathname,
      query: url.searchParams,
      headers: parseHeaders(headerLines.join('\n')),
      body: requestBody.replace(/\r?\n$/, ''),
    });
  }
  return parts;
}

/** Build the multipart/mixed response that Google returns for a batch. */
export function buildBatchResponse(
  results: readonly BatchPartResult[],
  boundary: string,
): string {
  return (
    results
      .map((result) =>
        [
          `--${boundary}`,
          'Content-Type: application/http',
          ...(result.contentId !== null
            ? [`Content-ID: <response-${result.contentId}>`]
            : []),
          '',
          `HTTP/1.1 ${result.status} ${STATUS_CODES[result.status] ?? 'Unknown'}`,
          ...Object.entries(result.headers).map(
            ([name, value]) => `${name}: ${value}`,
          ),
          '',
          result.body,
          '',
        ].join('\r\n'),
      )
      .join('') + `--${boundary}--\r\n`
  );
}
