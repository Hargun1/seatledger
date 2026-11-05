import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { machine, writeEvidence } from './lib/evidence-report.js';

const report = { kind: 'failures', startedAt: new Date().toISOString(), machine: machine(), passed: false, suites: [],
  limitations: ['separate existing correctness fixtures; not sustained-load fault injection',
    'API death case kills after acknowledgement; callback death case kills after inbox commit',
    'database stop/readiness/restart requires the separate isolated Docker foundation verifier'] };
const files = ['api-restart', 'reservation-api', 'payment-worker', 'payment-delivery', 'refund-worker', 'event-cancellation'];
try {
  for (const name of files) {
    const started = performance.now(); let result, failed = false;
    try { result = await promisify(execFile)(process.execPath, ['--env-file-if-exists=.env', '--test', '--test-reporter=tap', `tests/db/${name}.test.js`],
      { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { failed = true; result = { stdout: error.stdout || '' }; }
    // Store totals only. Never persist raw errors, SQL, cookies or child env.
    const total = label => { const matches = [...result.stdout.matchAll(new RegExp('^# ' + label + ' (\\d+)\\s*$', 'gm'))]; return matches.length ? Number(matches.at(-1)[1]) : null; };
    const suite = { name, elapsedMs: performance.now() - started, tests: total('tests'), pass: total('pass'), fail: total('fail'), cancelled: total('cancelled'), skipped: total('skipped'),
      passed: !failed && total('tests') > 0 && total('fail') === 0 && total('cancelled') === 0 && total('skipped') === 0 };
    report.suites.push(suite); if (!suite.passed) throw new Error('Failure suite did not pass');
  }
  report.passed = true;
} catch { process.exitCode = 1; console.error('Recovery acceptance failed; rerun the named suite directly for local diagnostics.'); }
finally { report.finishedAt = new Date().toISOString(); await writeEvidence('failures', report); }
