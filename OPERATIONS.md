# SeatLedger operations and reliability

This project demonstrates durable work, safe concurrent seat allocation, observability, access controls and recovery using real PostgreSQL and separate Node.js processes. Payments and test customers are synthetic.

## Run the acceptance demonstration

Run `npm run verify:operations` with Docker Desktop running. The verifier creates a separate loopback-only PostgreSQL container, applies migrations, seeds fictional data, runs unit and database acceptance, measures the load profile below, and pauses/unpauses only its own database. It removes its temporary Docker project afterward. It overrides the application `DATABASE_URL`; it does not migrate, stop or reset your development or hosted database.

JSON results and local logs are written under `test-results/operations/<timestamp>/`. `load.json` is copied into the same directory. Reports include failures; a process exit or missing load report cannot count as a pass. Do not infer production capacity from local results.

| Area | Reproducible demonstration |
| --- | --- |
| Distributed workers | `tests/db/distributed-workers.test.js` starts two independent CLI processes against one queued job. Exactly one completes it; another poll claims nothing. Existing provider, inbox and lease tests cover duplicates, conflicts, expired owners and permanent errors. |
| Observability | `tests/db/observability.test.js` checks real HTTP/database span correlation under concurrent pooled reads, protected metrics, route labels, and sensitive-data canaries. |
| Load | `scripts/measure-load.js` measures 1,000 synthetic customers, up to 250 simultaneous requests, and two API instances by default. |
| Security | `npm run test:security` exercises shared database auth rate limits, role/ownership restrictions, CSRF, session revocation, ticket replay/admission and metrics access against the configured test database. Test records live in private fixture schemas. |
| Recovery | The full database suite kills worker/API subprocesses and checks durable recovery without duplicate effects. The operations verifier additionally pauses its database with a payment queued, checks readiness 503/liveness 200, then resumes the same API and proves two competing workers produce one provider effect and one booking. |

`test:security` and `npm run evidence:load` require a reachable PostgreSQL database, unlike the self-contained `verify:operations` command. Keep fault injection local; do not aim it at the public demo.

## Worker delivery and retry policy

Outbox and delivery claims use short PostgreSQL transactions, `FOR UPDATE SKIP LOCKED`, bounded batches, and expiring lease tokens. Provider work happens after the claim commits. Finalization checks the current lease after row locks. An expired owner cannot acknowledge a newer worker's job.

Payment creation, refunds and callback deliveries use exponential retry delays starting from five seconds, with 20% jitter and a maximum delay of 3,600 seconds. Attempt budgets come from persisted jobs (eight by default). Permanent validation/identity failures go to dead-letter state. Exhausted abandoned leases are dead-lettered, too. Explicit requeue must extend the attempt budget. Inbox transaction retries retain their separate five-second policy.

Provider operations and received events have stable identities and unique database constraints. A worker can die after the external/simulated effect succeeds but before acknowledgement; retry then recovers the same effect. Delivery is **at least once**. There is no exactly-once external-delivery claim.

The free hosted deployment runs the API and six worker processes in one supervised service; it does not demonstrate independent hosted machines. The worker protocol supports competing processes against the same PostgreSQL database. Free hosting sleeps, so background work resumes after wake-up. Separate always-on worker services can use the same protocol if needed.

## Logs, metrics and traces

Every API response includes `X-Request-ID` and W3C-format `traceparent`. Structured request logs contain the request/trace/span IDs, method, **route template**, response status and duration. They never contain raw URLs, query strings, headers, bodies, SQL parameters or credentials. Expected 4xx rejections are informational; server failures are errors.

Request and database spans share a trace. Queued pool callbacks retain the waiting caller's context. Worker batches have their own traces; payment-creation job traces use the persisted job UUID, without hyphens, as a stable trace ID across retries/processes. Those job traces are independent of the original HTTP trace. Database spans record operation category and timing, not SQL text or errors. The default span sampling rate is 5%; set `TRACE_SAMPLE_RATE` between 0 and 1 to change it. Request logs and metrics are not sampled. Spans are structured JSON logs, not an installed OpenTelemetry collector or tracing dashboard.

`GET /api/metrics` returns Prometheus text with HTTP counters and latency histograms, active requests, database query/error/duration counters, pool connection/idle/waiter gauges, outbox counts/oldest age by kind/status, and process resident memory. HTTP labels are bounded route templates/methods/statuses; at most 512 HTTP label combinations are retained per API process.

Access requires either an active administrator session or an optional `METRICS_TOKEN` containing 64 lowercase hexadecimal characters, sent as `Authorization: Bearer <token>`. Keep the token in private environment configuration. Metrics responses are `no-store`; anonymous and customer access are rejected. No scraper token is created automatically.

Auth rate limits store HMAC digests of the immediate peer IP/email and share counters across API instances. Forwarding headers are not blindly trusted; the security suite verifies that a forged `X-Forwarded-For` cannot bypass the limit. Traffic sharing a reverse-proxy peer can share an IP bucket. Revisit trusted-proxy topology before treating this demo's IP policy as a general production edge policy.

Metrics are per API process and reset on restart. Each worker is a separate process; its activity/outcomes are emitted as `worker.batch` logs rather than being aggregated into the API process's counters. Outbox gauges come from shared PostgreSQL state. A monitoring system must scrape each API instance and ingest worker logs; no external collector or alerts are provisioned by these changes.

Useful investigations:

- Filter request logs by `requestId` or `traceId`, then find matching `trace.span` database rows.
- Compare request-duration histogram buckets with `seatledger_database_pool_waiting` to identify connection pressure.
- Inspect `seatledger_outbox_jobs` with status `RETRY_WAIT` or `DEAD_LETTER`, then inspect persisted job attempts/error codes. Completed-job age describes historical records; use READY/PROCESSING/RETRY_WAIT labels for backlog age.
- A pool-acquisition/query timeout returns `503 DATABASE_BUSY` with `Retry-After: 1`. A write's response can still be uncertain: use its original idempotency key and the application's explicit recovery workflow.

## Load profile and limits

The default is 1,000 total commands with a 250-request closed-loop concurrency window, not 1,000 simultaneous users sustained indefinitely. Sessions are pre-created; authentication setup is outside the timed workload. The verifier uses the existing production pool-acquisition timeout (10 seconds), ten connections per API, and a separate bounded worker pool. SQL/lock deadlines remain unchanged.

Three workloads run separately: all customers contend for one seat; customers contend for the physical 500-seat maximum of one show; customers request distinct seats across 20 shows. Reports separate success, expected conflict and unexpected error, record p50/p95/p99 latency and requests/second, sample connection/lock waiters, and inspect final allocation/price/agreement invariants in PostgreSQL.

Override `SEATLEDGER_LOAD_CLIENTS` (2-5,000) and `SEATLEDGER_LOAD_CONCURRENCY` (1-1,000) to explore other profiles. When running the standalone load command, use `NODE_ENV=production` for the production connection-acquisition budget; the report records which budget was used. A failed larger profile is a measured limit, not a reason to silently loosen assertions or report success.

The database pause test preserves stored data; it does not simulate disk loss, backups/restores or disaster recovery. Physical camera/printer, non-Chrome browser, sustained production traffic, third-party provider and penetration testing remain separate acceptance boundaries.

## Recorded local results

The [6 November 2026 result snapshot](benchmarks/operations-2026-11-06.json) records 136 unit tests, 231 database/API tests and a separate 81-test browser run passing. The dedicated 46-test security command is a subset of the database checks, not an additional 46 tests. At 250 concurrent requests across two APIs:

| Workload | Requests | Successful holds | Expected conflicts | Unexpected responses | p95 latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| One seat | 1,000 | 1 | 999 | 0 | 2,097 ms |
| One 500-seat show | 1,000 | 500 | 500 | 0 | 1,766 ms |
| Seats across 20 shows | 1,000 | 1,000 | 0 | 0 | 1,820 ms |

All three runs found zero invalid allocations or agreements. After a database pause, the same API recovered and two competing workers completed the pending work with one simulated provider effect and one booking. Separate process tests also cover worker death after provider commit, callback/inbox recovery, and duplicate claims. This is one local measured sample, not a production throughput promise.
