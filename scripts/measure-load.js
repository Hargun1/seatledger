import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { evidenceFixture } from './lib/evidence-fixture.js';
import { distribution, integerOption, machine, writeEvidence } from './lib/evidence-report.js';
import { runExpiryBatch } from '../apps/api/src/reservations/expiry.js';

const clients = integerOption('SEATLEDGER_LOAD_CLIENTS', 100, 2, 500);
const concurrency = integerOption('SEATLEDGER_LOAD_CONCURRENCY', 25, 1, 100);
const report = { kind: 'load', startedAt: new Date().toISOString(), machine: machine(), clients, concurrency,
  apiInstances: 2, poolLimitPerInstance: 10, workerPoolLimit: 10, workload: 'bounded closed-loop HTTP holds; sessions pre-created',
  limitations: ['local host only', 'not open-loop sustained traffic', 'sampled connection/lock maxima', 'not whole checkout throughput'], runs: [], passed: false };
try {
  await evidenceFixture(async c => {
    report.postgres = (await c.pool.query('SELECT version() AS version')).rows[0].version; report.migrations = c.migrations;
    const people = []; for (let i = 0; i < clients; i++) people.push(await c.actor());
    for (const kind of ['one-seat', 'one-show', 'many-shows']) {
      const shows = [], groups = kind === 'many-shows' ? Math.min(clients, 20) : 1;
      for (let i = 0; i < groups; i++) {
        const f = await c.catalogue(); f.seats = await c.addSeats(f, kind === 'one-seat' ? 1 : Math.ceil(clients / groups)); shows.push(f);
      }
      const run = { kind, requests: clients, apiRequests: [0, 0], successes: 0, conflicts: 0, unexpected: {}, worker: { batches: 0, failed: 0 },
        sampled: { samples: 0, maxConnections: 0, maxCheckedOut: 0, maxPoolWaiters: 0, maxLockWaiters: 0 }, invariantsPassed: false };
      report.runs.push(run); const latencies = [], byOutcome = { success: [], conflict: [], error: [] }; let next = 0, stopped = false;
      const worker = (async () => {
        while (!stopped) {
          try {
            const batch = await runExpiryBatch(c.pool, { batchSize: 20 }); run.worker.batches++; run.worker.failed += batch.failed;
            const sample = run.sampled; sample.samples++;
            sample.maxConnections = Math.max(sample.maxConnections, c.pools.reduce((n, p) => n + p.totalCount, 0));
            sample.maxCheckedOut = Math.max(sample.maxCheckedOut, c.pools.reduce((n, p) => n + p.totalCount - p.idleCount, 0));
            sample.maxPoolWaiters = Math.max(sample.maxPoolWaiters, c.pools.reduce((n, p) => n + p.waitingCount, 0));
            const waits = (await c.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'", [[...c.backendPids]])).rows[0].n;
            sample.maxLockWaiters = Math.max(sample.maxLockWaiters, waits);
          } catch { run.worker.failed++; }
          if (!stopped) await delay(25);
        }
      })();
      const start = performance.now();
      try {
        await Promise.all(Array.from({ length: Math.min(concurrency, clients) }, async () => {
          while (next < clients) {
            const i = next++, f = shows[i % groups], seatId = f.seats[kind === 'one-seat' ? 0 : Math.floor(i / groups)];
            const at = performance.now(); let outcome = 'error';
            run.apiRequests[i % 2]++;
            try {
              const response = await c.request(people[i], '/api/reservations', { method: 'POST', api: i % 2, body: { showId: f.show, seatIds: [seatId] } });
              const body = await response.json();
              if (response.status === 201) { run.successes++; outcome = 'success'; }
              else if (response.status === 409 && body.error === 'SEATS_UNAVAILABLE') { run.conflicts++; outcome = 'conflict'; }
              else { const code = String(response.status); run.unexpected[code] = (run.unexpected[code] || 0) + 1; }
            } catch { run.unexpected.transport = (run.unexpected.transport || 0) + 1; }
            const elapsed = performance.now() - at; latencies.push(elapsed); byOutcome[outcome].push(elapsed);
          }
        }));
      } finally { run.elapsedMs = performance.now() - start; stopped = true; await worker; }
      run.requestsPerSecond = clients / (run.elapsedMs / 1000); run.latency = distribution(latencies);
      run.latencyByOutcome = Object.fromEntries(Object.entries(byOutcome).map(([name, values]) => [name, distribution(values)]));
      const ids = shows.map(f => f.show);
      run.final = (await c.pool.query(`SELECT
        (SELECT count(*)::int FROM reservations WHERE show_id=ANY($1::uuid[])) AS reservations,
        (SELECT count(*)::int FROM show_seats WHERE show_id=ANY($1::uuid[]) AND state='HELD') AS "heldSeats",
        (SELECT count(*)::int FROM show_seats s LEFT JOIN reservations r ON r.id=s.reservation_id
          WHERE s.show_id=ANY($1::uuid[]) AND s.state='HELD' AND (r.id IS NULL OR r.status<>'ACTIVE' OR r.expires_at<>s.expires_at
          OR NOT EXISTS(SELECT 1 FROM reservation_items i WHERE i.reservation_id=r.id AND i.show_id=s.show_id AND i.venue_seat_id=s.venue_seat_id))) AS "invalidAllocations",
        (SELECT count(*)::int FROM reservations r WHERE r.show_id=ANY($1::uuid[]) AND
          (r.sealed_at IS NULL OR (SELECT count(*) FROM reservation_items i WHERE i.reservation_id=r.id)<>1
          OR r.total_minor<>(SELECT coalesce(sum(price_minor),0) FROM reservation_items i WHERE i.reservation_id=r.id)
          OR NOT EXISTS(SELECT 1 FROM show_seats s WHERE s.reservation_id=r.id AND s.state='HELD'))) AS "invalidAgreements"`, [ids])).rows[0];
      assert.deepEqual(run.unexpected, {}); assert.equal(run.worker.failed, 0); assert.ok(run.worker.batches > 0);
      assert.equal(run.successes, kind === 'one-seat' ? 1 : clients); assert.equal(run.conflicts, kind === 'one-seat' ? clients - 1 : 0);
      assert.deepEqual(run.final, { reservations: run.successes, heldSeats: run.successes, invalidAllocations: 0, invalidAgreements: 0 });
      assert.ok(run.apiRequests.every(n => n > 0));
      run.invariantsPassed = true;
    }
  }, { apiCount: 2 }); report.passed = true;
} catch { process.exitCode = 1; console.error('Load verification failed; inspect the bounded report and rerun acceptance tests.'); }
finally { report.finishedAt = new Date().toISOString(); await writeEvidence('load', report); }
