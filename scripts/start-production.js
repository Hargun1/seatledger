import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../apps/api/src/config.js';

const config = readConfig();
if (!config.SIMULATOR_WEBHOOK_SECRET) throw new Error('Hosted simulated delivery requires its separate signing key.');
const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['apps/api/src/server.js', 'apps/api/src/reservations/expiry-worker.js',
  'apps/api/src/payments/outbox-worker.js', 'apps/api/src/payments/delivery-worker.js',
  'apps/api/src/payments/inbox-worker.js', 'apps/api/src/payments/refund-worker.js',
  'apps/api/src/organizers/event-cancellation-worker.js'];
const children = new Set();
let closing = false, exitCode = 0;
function shutdown(code = 0) {
  if (closing) return;
  closing = true; exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  if (!children.size) process.exit(exitCode);
  const deadline = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(1);
  }, 15000);
  deadline.unref();
}
function start(file) {
  const child = spawn(process.execPath, [file], { cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, SIMULATOR_CALLBACK_URL: `http://127.0.0.1:${config.PORT}/api/payments/simulated/events` } });
  children.add(child);
  console.log(JSON.stringify({ service: 'seatledger-runtime', event: 'child-started', file, pid: child.pid }));
  child.once('error', () => shutdown(1));
  child.once('exit', () => {
    children.delete(child);
    if (!closing) shutdown(1); // Never keep a partly working API/worker group.
    if (closing && !children.size) process.exit(exitCode);
  });
}
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
start(files[0]);
let ready = false;
for (let attempt = 0; attempt < 60 && !closing; attempt++) {
  try { ready = (await fetch(`http://127.0.0.1:${config.PORT}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { /* API has not bound its loopback listener yet. */ }
  if (ready) break;
  await delay(150);
}
if (!ready) shutdown(1);
else if (!closing) for (const file of files.slice(1)) start(file);
