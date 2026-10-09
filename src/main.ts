import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { parseTiming } from './clock.ts';
import { createControlHandler } from './control/control.ts';
import { createMock } from './mock.ts';

const env = process.env;
const port = (value: string | undefined, fallback: number) => {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535)
    throw new Error(`Invalid port: ${value}`);
  return parsed;
};

const dataDir = env.MOCK_DATA_DIR ?? '/data';
const timing = parseTiming(env.MOCK_TIME_SCALE, env.MOCK_DELAYS);
const mock = createMock({ dataDir, timing });
if (env.MOCK_CA_EXPORT) {
  mkdirSync(dirname(env.MOCK_CA_EXPORT), { recursive: true });
  writeFileSync(env.MOCK_CA_EXPORT, mock.certificates.caCert, { mode: 0o644 });
}
const google = await mock.listenGoogle(
  port(env.MOCK_GOOGLE_PORT, 443),
  env.MOCK_GOOGLE_HOST ?? '0.0.0.0',
);
const control = http.createServer(createControlHandler(mock));
control.listen(
  port(env.MOCK_CONTROL_PORT, 8080),
  env.MOCK_CONTROL_HOST ?? '127.0.0.1',
);
await once(control, 'listening');
console.log(
  JSON.stringify({
    event: 'started',
    googlePort: (google.address() as AddressInfo).port,
    controlPort: (control.address() as AddressInfo).port,
    dataDir,
    timing,
  }),
);

const stop = () => {
  control.close();
  mock.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
