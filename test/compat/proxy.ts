import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';

/** Forward CONNECT requests for *.googleapis.com:443 to the mock. Refuse every other host. */
export async function startConnectProxy(target: {
  host: string;
  port: number;
}): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_request, response) =>
    response.writeHead(405).end(),
  );
  server.on(
    'connect',
    (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      const [host, port] = (request.url ?? '').split(':');
      if (!host.endsWith('.googleapis.com') || port !== '443') {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = net.connect(target.port, target.host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      for (const side of [socket, upstream]) {
        sockets.add(side);
        side.on('close', () => sockets.delete(side));
        side.on('error', () => {
          socket.destroy();
          upstream.destroy();
        });
      }
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
