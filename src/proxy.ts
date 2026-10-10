import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';

export const GOOGLE_HOSTS: readonly string[] = [
  'oauth2.googleapis.com',
  'admin.googleapis.com',
  'www.googleapis.com',
  'chromemanagement.googleapis.com',
];

/** How many targets each list of a ProxyHandle keeps. Older targets drop off. */
export const KEPT_TARGETS = 1_000;

/** The CONNECT requests that the proxy has handled since it started. */
export interface ProxyCounts {
  accepted: number;
  refused: number;
  tunneled: number;
}

export interface ProxyHandle {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  /** The last KEPT_TARGETS targets tunneled to the mock, oldest first. */
  readonly accepted: readonly string[];
  /** The last KEPT_TARGETS targets refused with 403, oldest first. */
  readonly refused: readonly string[];
  /** The last KEPT_TARGETS targets tunneled as-is with passthrough, oldest first. */
  readonly tunneled: readonly string[];
  /** The running totals, which count every target the lists dropped. */
  counts(): ProxyCounts;
  close(): Promise<void>;
}

/** Loopback addresses: 127.0.0.0/8 and ::1. BlockList also matches their IPv4-mapped forms. */
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/**
 * The addresses that passthrough never tunnels to: loopback, link-local, and unspecified.
 * They reach the mock's own listeners and cloud metadata endpoints such as 169.254.169.254.
 */
const LOCAL = new net.BlockList();
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('169.254.0.0', 16, 'ipv4');
LOCAL.addAddress('0.0.0.0', 'ipv4');
LOCAL.addAddress('::1', 'ipv6');
LOCAL.addSubnet('fe80::', 10, 'ipv6');
LOCAL.addAddress('::', 'ipv6');

/**
 * The address a host names, or null for a host name. A literal IPv6 address loses its zone
 * ID. An IPv4 literal is normalized the way the resolver reads it, so `127.1`, `2130706433`,
 * and `0x7f.1` all become `127.0.0.1`.
 */
function literalAddress(
  host: string,
): { address: string; type: 'ipv4' | 'ipv6' } | null {
  if (host.includes(':')) {
    const address = host.replace(/%.*$/, '');
    return net.isIPv6(address) ? { address, type: 'ipv6' } : null;
  }
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
  return net.isIPv4(name) ? { address: name, type: 'ipv4' } : null;
}

/** Whether a listener host is `localhost` or a literal loopback address. */
export function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  const literal = literalAddress(host);
  return literal !== null && LOOPBACK.check(literal.address, literal.type);
}

/**
 * Whether a passthrough target names this host or its link: `localhost`, a `.localhost`
 * name, or a literal loopback, link-local, or unspecified address. A host name that
 * resolves to such an address is not caught.
 */
function isLocalTarget(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const literal = literalAddress(host);
  return literal !== null && LOCAL.check(literal.address, literal.type);
}

/**
 * Split `host:port`, including a bracketed IPv6 host, and drop one trailing dot from the
 * host, so `admin.googleapis.com.` matches as a Google hostname. Returns null for a
 * malformed target.
 */
function parseTarget(target: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  const host = match[1]
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  return { host, port };
}

/**
 * A CONNECT proxy. Port 443 of a Google hostname tunnels to the mock's Google
 * listener. Any other target is refused with 403, or tunneled as-is with
 * passthrough. Passthrough still refuses a local target (see isLocalTarget).
 * The proxy never terminates TLS.
 */
export async function startProxy(options: {
  host: string;
  port: number;
  target: { host: string; port: number };
  passthrough: boolean;
  log?: (event: Record<string, unknown>) => void;
}): Promise<ProxyHandle> {
  const accepted: string[] = [];
  const refused: string[] = [];
  const tunneled: string[] = [];
  const counts: ProxyCounts = { accepted: 0, refused: 0, tunneled: 0 };
  const record = (kind: keyof ProxyCounts, target: string) => {
    counts[kind]++;
    const list = { accepted, refused, tunneled }[kind];
    list.push(target);
    if (list.length > KEPT_TARGETS) list.shift();
  };
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const server = http.createServer((_request, response) =>
    response.writeHead(405).end(),
  );
  server.on(
    'connect',
    (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
      track(client);
      client.on('error', () => client.destroy());
      const raw = request.url ?? '';
      const target = parseTarget(raw);
      const google =
        target !== null &&
        target.port === 443 &&
        GOOGLE_HOSTS.includes(target.host);
      if (
        !target ||
        (!google && (!options.passthrough || isLocalTarget(target.host)))
      ) {
        record('refused', raw);
        options.log?.({ event: 'proxy-refused', target: raw });
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      record(google ? 'accepted' : 'tunneled', raw);
      const destination = google ? options.target : target;
      const upstream = net.connect(destination.port, destination.host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      track(upstream);
      upstream.on('error', () => {
        if (!client.writableEnded && client.bytesWritten === 0)
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        else client.destroy();
      });
      client.on('close', () => upstream.destroy());
    },
  );
  server.listen(options.port, options.host);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    port,
    host: options.host,
    url: `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${port}`,
    accepted,
    refused,
    tunneled,
    counts: () => ({ ...counts }),
    close: () =>
      (closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        server.close();
        await once(server, 'close').catch(() => undefined);
      })()),
  };
}
