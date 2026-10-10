import { runCli } from './cli/main.ts';

// `npm start` runs the same start path, flags, and exit codes as `admin-sdk-mock start`.
process.exitCode = await runCli(['start', ...process.argv.slice(2)]);
