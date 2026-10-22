import { realSleep } from './http/pacer.js';
import { run } from './main.js';

const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  process.stderr.write('\nStopping… (Ctrl+C again to quit now)\n');
  controller.abort();
});

if (typeof globalThis.fetch !== 'function') {
  process.stderr.write('error: this version of Node has no fetch. Use Node 18 or later.\n');
  process.exit(1);
}

const code = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  fetch: globalThis.fetch,
  sleep: realSleep,
  clock: Date.now,
  signal: controller.signal,
});
process.exitCode = code;
