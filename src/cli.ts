import { realSleep } from './http/pacer.js';
import { run } from './main.js';

const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  process.stderr.write('\nCortando… (Ctrl+C otra vez para salir ya)\n');
  controller.abort();
});

if (typeof globalThis.fetch !== 'function') {
  process.stderr.write('error: esta versión de Node no tiene fetch. Usa Node 18 o posterior.\n');
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
