import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { logger as runtimeLogger } from './logger.js';

const context = new AsyncLocalStorage();
const buckets = [.005, .01, .025, .05, .1, .25, .5, 1, 2, 5, 10];
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const operations = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'WITH']);
const workerCounts = ['claimed', 'completed', 'processed', 'delivered', 'expired', 'retryScheduled', 'deadLettered', 'stale', 'failed'];
const hex = size => randomBytes(size).toString('hex');
const labels = value => JSON.stringify(value); // Only bounded internal labels are passed here.

export function traceParent(value) {
  const match = typeof value === 'string' && /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  return match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2]) ? { traceId: match[1], spanId: match[2] } : null;
}
export function validMetricsToken(value, configured) {
  return typeof configured === 'string' && /^[a-f0-9]{64}$/.test(configured)
    && typeof value === 'string' && /^Bearer [a-f0-9]{64}$/.test(value)
    && timingSafeEqual(Buffer.from(value.slice(7)), Buffer.from(configured));
}

export function createTelemetry({ logger = runtimeLogger, sampleRate = .05 } = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new TypeError('Invalid trace sampling rate');
  const requests = new Map(), database = new Map();
  let active = 0;
  const telemetry = {
    current: () => context.getStore(),
    start(name, { parent = context.getStore(), traceId } = {}) {
      return { telemetry, name, traceId: traceId || parent?.traceId || hex(16), spanId: hex(8),
        parentSpanId: traceId ? null : parent?.spanId || null, requestId: parent?.requestId,
        sampled: parent?.sampled ?? Math.random() < sampleRate, started: performance.now() };
    },
    end(span, fields = {}, failed = false) {
      if (span.sampled) logger.info({ event: 'trace.span', name: span.name, traceId: span.traceId, spanId: span.spanId,
        parentSpanId: span.parentSpanId, durationMs: performance.now() - span.started,
        outcome: failed ? 'error' : 'ok', ...fields }, 'trace span');
    },
    async span(name, work, options) {
      const span = telemetry.start(name, options);
      return context.run(span, async () => {
        try { const value = await work(); telemetry.end(span, {}, Boolean(value?.failed)); return value; }
        catch (error) { telemetry.end(span, {}, true); throw error; }
      });
    },
    middleware(req, res, next) {
      const parent = traceParent(req.get('traceparent'));
      const span = telemetry.start('http.request', { parent });
      span.requestId = randomUUID();
      const method = methods.has(req.method) ? req.method : 'OTHER';
      res.set({ 'X-Request-ID': span.requestId, traceparent: `00-${span.traceId}-${span.spanId}-${span.sampled ? '01' : '00'}` });
      active++;
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true; active--;
        const template = typeof req.route?.path === 'string' ? (req.baseUrl || '') + req.route.path : 'unmatched';
        const route = /^[A-Za-z0-9_/:.-]{1,180}$/.test(template) ? template : 'unmatched';
        const status = res.writableFinished ? res.statusCode : 499;
        const key = labels([method, route, status]), duration = (performance.now() - span.started) / 1000;
        if (requests.has(key) || requests.size < 512) {
          const row = requests.get(key) || { method, route, status, count: 0, sum: 0, buckets: buckets.map(() => 0) };
          row.count++; row.sum += duration; buckets.forEach((limit, i) => { if (duration <= limit) row.buckets[i]++; }); requests.set(key, row);
        }
        const fields = { requestId: span.requestId, traceId: span.traceId, spanId: span.spanId, method, route, status, durationMs: duration * 1000 };
        logger.info({ event: 'http.request', ...fields }, 'request'); telemetry.end(span, { method, route, status }, status >= 500);
      };
      res.once('finish', finish); res.once('close', finish);
      context.run(span, next);
    },
    database(operation, duration, failed) {
      const row = database.get(operation) || { count: 0, errors: 0, seconds: 0 };
      row.count++; row.errors += Number(failed); row.seconds += duration / 1000; database.set(operation, row);
    },
    worker(name, counts, duration) {
      const safe = Object.fromEntries(workerCounts.filter(key => Number.isInteger(counts?.[key]) && counts[key] >= 0).map(key => [key, counts[key]]));
      if (Object.values(safe).some(Boolean)) logger.info({ event: 'worker.batch', worker: name,
        traceId: context.getStore()?.traceId, durationMs: duration, ...safe }, 'worker batch');
    },
    render(pool, queues = []) {
      const lines = ['# TYPE seatledger_http_requests_total counter', '# TYPE seatledger_http_request_duration_seconds histogram',
        '# TYPE seatledger_http_active_requests gauge', `seatledger_http_active_requests ${active}`];
      for (const row of requests.values()) {
        const fields = `method=${labels(row.method)},route=${labels(row.route)},status=${labels(String(row.status))}`;
        lines.push(`seatledger_http_requests_total{${fields}} ${row.count}`);
        row.buckets.forEach((count, i) => lines.push(`seatledger_http_request_duration_seconds_bucket{${fields},le="${buckets[i]}"} ${count}`));
        lines.push(`seatledger_http_request_duration_seconds_bucket{${fields},le="+Inf"} ${row.count}`,
          `seatledger_http_request_duration_seconds_count{${fields}} ${row.count}`, `seatledger_http_request_duration_seconds_sum{${fields}} ${row.sum}`);
      }
      lines.push('# TYPE seatledger_database_queries_total counter', '# TYPE seatledger_database_errors_total counter', '# TYPE seatledger_database_query_duration_seconds_total counter');
      for (const [operation, row] of database) lines.push(`seatledger_database_queries_total{operation=${labels(operation)}} ${row.count}`,
        `seatledger_database_errors_total{operation=${labels(operation)}} ${row.errors}`,
        `seatledger_database_query_duration_seconds_total{operation=${labels(operation)}} ${row.seconds}`);
      for (const [name, value] of [['connections', pool?.totalCount], ['idle', pool?.idleCount], ['waiting', pool?.waitingCount]])
        if (Number.isInteger(value)) lines.push(`# TYPE seatledger_database_pool_${name} gauge`, `seatledger_database_pool_${name} ${value}`);
      lines.push('# TYPE seatledger_outbox_jobs gauge', '# TYPE seatledger_outbox_oldest_job_age_seconds gauge');
      for (const row of queues) {
        const fields = `kind=${labels(row.kind)},status=${labels(row.status)}`;
        lines.push(`seatledger_outbox_jobs{${fields}} ${row.count}`, `seatledger_outbox_oldest_job_age_seconds{${fields}} ${row.age}`);
      }
      lines.push('# TYPE seatledger_process_resident_memory_bytes gauge', `seatledger_process_resident_memory_bytes ${process.memoryUsage().rss}`);
      return lines.join('\n') + '\n';
    }
  };
  return telemetry;
}

export const runtimeTelemetry = createTelemetry({ sampleRate: Number(process.env.TRACE_SAMPLE_RATE ?? .05) });

// pg's pool hands queued callbacks to the connection releasing a slot. Bind
// them to the waiting caller so one request cannot inherit another's trace.
export function bindTraceCallback(callback) {
  const span = context.getStore();
  return function (...args) { return context.run(span, () => callback.apply(this, args)); };
}

// Preserve pg's promise and callback interfaces. Never record SQL text, query
// parameters, connection strings or error messages in telemetry.
export function instrumentClient(client) {
  const original = client.query.bind(client);
  client.query = function (...args) {
    const parent = context.getStore();
    if (!parent) return original(...args);
    const telemetry = parent.telemetry, started = performance.now();
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const first = text?.trim().split(/\s+/, 1)[0]?.toUpperCase();
    const operation = operations.has(first) ? first : 'OTHER', span = parent.sampled ? telemetry.start('database.query') : null;
    let done = false;
    const finish = failed => { if (done) return; done = true;
      telemetry.database(operation, performance.now() - started, failed); if (span) telemetry.end(span, { operation }, failed); };
    const callback = typeof args.at(-1) === 'function' && args.at(-1);
    if (callback) args[args.length - 1] = function (error, ...rest) { finish(Boolean(error)); return callback.call(this, error, ...rest); };
    try {
      const result = original(...args);
      return result?.then ? result.then(value => { finish(false); return value; }, error => { finish(true); throw error; }) : result;
    } catch (error) { finish(true); throw error; }
  };
}
