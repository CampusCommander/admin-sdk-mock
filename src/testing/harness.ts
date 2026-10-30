import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenDomain } from '../http/types.ts';
import { createMock, type Mock, type MockOptions } from '../mock.ts';

export interface HarnessResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): any;
}

export interface RequestOptions {
  host: string;
  path: string;
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  token?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface Harness {
  mock: Mock;
  port: number;
  dataDir: string;
  request(options: RequestOptions): Promise<HarnessResponse>;
  close(): Promise<void>;
}

/** Start a mock on a random loopback port. Delays are off unless a test turns them on. */
export async function startHarness(
  options: Partial<MockOptions> = {},
): Promise<Harness> {
  const dataDir =
    options.dataDir ?? mkdtempSync(join(tmpdir(), 'admin-sdk-mock-'));
  const mock = createMock({
    timing: { scale: 1, delays: false },
    ...options,
    dataDir,
  });
  const server = await mock.listenGoogle(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  return {
    mock,
    port,
    dataDir,
    request({ host, path, method = 'GET', query, token, headers = {}, body }) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query ?? {}))
        if (value !== undefined) search.set(key, String(value));
      const target = search.size > 0 ? `${path}?${search}` : path;
      return new Promise((resolve, reject) => {
        const outgoing = https.request(
          {
            host: '127.0.0.1',
            port,
            path: target,
            method,
            servername: host,
            ca: mock.certificates.caCert,
            agent: false,
            headers: {
              host,
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(body !== undefined
                ? { 'content-length': String(Buffer.byteLength(body)) }
                : {}),
              ...headers,
            },
          },
          (incoming) => {
            let text = '';
            incoming.setEncoding('utf8');
            incoming.on('data', (chunk: string) => (text += chunk));
            incoming.on('end', () =>
              resolve({
                status: incoming.statusCode ?? 0,
                headers: incoming.headers,
                text,
                json: () => JSON.parse(text),
              }),
            );
          },
        );
        outgoing.on('error', reject);
        if (body !== undefined) outgoing.write(body);
        outgoing.end();
      });
    },
    async close() {
      mock.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const TEST_SPEC = {
  tier: 'small',
  seed: 'harness',
  counts: { schools: 2, students: 120, staff: 20, devices: 150 },
};

/** Seed a small domain for HTTP tests. */
export function seedTestDomain(
  harness: Harness,
  input: Record<string, unknown> = TEST_SPEC,
): OpenDomain {
  return harness.mock.domains.create(input, harness.mock.clock.now()).domain;
}

export const adminOf = (domain: OpenDomain): string =>
  `admin@${domain.spec.primaryDomain}`;

/** Store an access token directly, without the token endpoint. */
export function grantToken(
  harness: Harness,
  domain: OpenDomain,
  scopes: readonly string[],
  subject = adminOf(domain),
): string {
  const token = `ya29.test.${randomUUID()}`;
  harness.mock.registry.saveToken({
    token,
    clientId: '100000000000000000001',
    projectId: 'harness-project',
    subject,
    customerId: domain.customerId,
    scopes: [...scopes],
    expiresAt: harness.mock.clock.now() + 3_599_000,
  });
  return token;
}

export type DirectoryClient = (
  method: string,
  path: string,
  options?: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
  },
) => Promise<HarnessResponse>;

/** Call one Google host with a path prefix, such as `/drive/v3`. */
export function googleClient(
  harness: Harness,
  token: string,
  host: string,
  prefix = '',
): DirectoryClient {
  return (method, path, options = {}) =>
    harness.request({
      host,
      method,
      path: `${prefix}${path}`,
      token,
      query: options.query,
      headers: options.headers,
      ...(options.body === undefined
        ? {}
        : {
            body:
              typeof options.body === 'string'
                ? options.body
                : JSON.stringify(options.body),
            headers: {
              'content-type': 'application/json',
              ...options.headers,
            },
          }),
    });
}
export function directoryClient(
  harness: Harness,
  token: string,
): DirectoryClient {
  return (method, path, options = {}) =>
    harness.request({
      host: 'admin.googleapis.com',
      method,
      path: `/admin/directory/v1${path}`,
      token,
      query: options.query,
      ...(options.body === undefined
        ? {}
        : {
            body:
              typeof options.body === 'string'
                ? options.body
                : JSON.stringify(options.body),
            headers: { 'content-type': 'application/json' },
          }),
    });
}
