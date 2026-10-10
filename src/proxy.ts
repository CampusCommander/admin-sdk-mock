import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';

export const GOOGLE_HOSTS: readonly string[] = [
  'oauth2.googleapis.com',
  'admin.googleapis.com',
  'www.googleapis.com',
  'chromemanagement.googleapis.com',
];

export interface ProxyHandle {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly accepted: string[];
  readonly refused: string[];
  readonly tunneled: string[];
  close(): Promise<void>;
}

/** Split `host:port`, including a bracketed IPv6 host. Returns null for a malformed target. */
function parseTarget(target: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  return { host: match[1].replace(/^\[|\]$/g, '').toLowerCase(), port };
}

/**
 * A CONNECT proxy. Port 443 of a Google hostname tunnels to the mock's Google
 * listener. Any other target is refused with 403, or tunneled as-is with
 * passthrough. The proxy never terminates TLS.
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
      if (!target || (!google && !options.passthrough)) {
        refused.push(raw);
        options.log?.({ event: 'proxy-refused', target: raw });
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      (google ? accepted : tunneled).push(raw);
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
  return {
    port,
    host: options.host,
    url: `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${port}`,
    accepted,
    refused,
    tunneled,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}
