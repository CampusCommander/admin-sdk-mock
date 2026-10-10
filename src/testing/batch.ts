export interface BatchRequestPart {
  id: string;
  method: string;
  /** An absolute Directory path, such as /admin/directory/v1/users. */
  path: string;
  body?: unknown;
}

/** Build a multipart/mixed batch body. */
export function batchBody(
  parts: readonly BatchRequestPart[],
  boundary = 'batch',
): string {
  return (
    parts
      .map((part) => {
        const head = `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${part.id}>\r\n\r\n${part.method} ${part.path}\r\n`;
        return part.body === undefined
          ? `${head}\r\n`
          : `${head}Content-Type: application/json\r\n\r\n${JSON.stringify(part.body)}\r\n`;
      })
      .join('') + `--${boundary}--\r\n`
  );
}

/** The HTTP status of each part of a batch response, by request Content-ID. */
export function batchStatuses(text: string): Map<string, number> {
  const statuses = new Map<string, number>();
  for (const match of text.matchAll(
    /Content-ID: <response-([^>]+)>\r\n\r\nHTTP\/1\.1 (\d{3})/g,
  ))
    statuses.set(match[1], Number(match[2]));
  return statuses;
}
