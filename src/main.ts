import { ConfigError } from './config/config.ts';
import { FixtureError } from './seed/fixtures.ts';
import { SpecError } from './seed/spec.ts';
import { loadStartupConfig, startServer } from './server.ts';

const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify(event));

try {
  const server = await startServer(
    loadStartupConfig({ env: process.env, cwd: process.cwd() }),
    { log },
  );
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  if (error instanceof ConfigError || error instanceof FixtureError) {
    for (const line of error.errors) console.error(line);
    process.exit(2);
  }
  if (error instanceof SpecError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
