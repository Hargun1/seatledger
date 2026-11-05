import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evidenceFixture } from './lib/evidence-fixture.js';
import { distribution, integerOption, machine, writeEvidence } from './lib/evidence-report.js';
import { discoverEvents, publicSeats } from '../apps/api/src/discovery/service.js';
import { readOperationsSummary } from '../apps/api/src/organizers/operations.js';
import { createApp } from '../apps/api/src/app.js';

const shows = integerOption('SEATLEDGER_BENCH_SHOWS', 200, 2, 2000);
const seats = integerOption('SEATLEDGER_BENCH_SEATS', 500, 1, 500);
const histories = integerOption('SEATLEDGER_BENCH_HISTORY', 2000, 25, 20000);
const repeats = integerOption('SEATLEDGER_BENCH_REPEATS', 5, 2, 20);
const seed = integerOption('SEATLEDGER_BENCH_SEED', 42, 0, 2147483647);
const report = { kind: 'queries', startedAt: new Date().toISOString(), machine: machine(), seed, repeats,
  configured: { shows, seatsPerShow: seats, histories }, passed: false, comparisons: [],
  limitations: ['synthetic SQL history and captures', 'warm-cache repeated local runs; no cache flush',
    'without-selected-indexes is an experimental baseline, not an earlier application revision', 'no production index change'] };
try {
  await evidenceFixture(async c => {
    report.postgres = (await c.pool.query('SELECT version() AS version')).rows[0].version; report.migrations = c.migrations;
    const f = await c.catalogue('Query fixture'), person = await c.actor(f.user);
    // Stable synthetic identities within this isolated schema. Catalogue's anchor
    // identity is random; expansion is reproducible from the recorded integer seed.
    const identity = (kind, n) => createHash('md5').update(`${seed}:${kind}:${n}`).digest('hex');
    await c.addSeats(f, seats);
    const expanded = Array.from({ length: shows - 1 }, (_, i) => ({ event: identity('event', i), show: identity('show', i) }));
    await c.tx(async db => {
      const long = (text, values) => db.query({ text, values, query_timeout: 120000 });
      await long(`INSERT INTO events(id,organizer_id,title,category,status)
        SELECT (x->>'event')::uuid,$1,'Benchmark programme '||n,'Talks','PUBLISHED'
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS a(x,n)`, [f.org, JSON.stringify(expanded)]);
      await long(`INSERT INTO shows(id,event_id,venue_id,organizer_id,starts_at,base_price_minor,currency)
        SELECT (x->>'show')::uuid,(x->>'event')::uuid,$1,$2,clock_timestamp()+interval '7 days'+n*interval '1 minute',75000,'INR'
        FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS a(x,n)`, [f.venue, f.org, JSON.stringify(expanded)]);
      await long(`INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor,currency)
        SELECT s.id,v.id,v.venue_id,75000,'INR' FROM shows s CROSS JOIN venue_seats v WHERE s.id<>$1`, [f.show]);
      // Historical agreements are sealed in the same order as the storage API.
      await long(`INSERT INTO reservations(id,user_id,show_id,total_minor,currency,created_at,expires_at,status,closed_at)
        SELECT md5($3::text||':reservation:'||n)::uuid,$1,$2,75000,'INR',at,at+interval '5 minutes','CONFIRMED',clock_timestamp()
        FROM generate_series(1,$4::int) n CROSS JOIN LATERAL(SELECT clock_timestamp()-interval '1 day'-n*interval '1 second' AS at) stamp`, [person.id, f.show, seed, histories]);
      await long(`INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency)
        SELECT id,show_id,$1,75000,'INR' FROM reservations`, [f.seat]);
      await long('UPDATE reservations SET sealed_at=clock_timestamp()', []);
      await long(`INSERT INTO bookings(reservation_id,user_id,show_id,total_minor,currency,created_at)
        SELECT id,user_id,show_id,total_minor,currency,created_at+interval '1 second' FROM reservations`, []);
      await long(`INSERT INTO booking_items(booking_id,reservation_id,show_id,venue_seat_id,price_minor,currency,section_name,row_label,seat_number)
        SELECT id,reservation_id,show_id,$1,75000,'INR','Stalls','A',1 FROM bookings`, [f.seat]);
      await long('UPDATE bookings SET sealed_at=clock_timestamp()', []);
      await long(`INSERT INTO payment_attempts(reservation_id,user_id,show_id,amount_minor,currency,provider_payment_id,created_at)
        SELECT reservation_id,user_id,show_id,total_minor,currency,'bench_'||id,created_at FROM bookings`, []);
      await long(`UPDATE payment_attempts p SET status='SUCCEEDED',resolution='BOOKED',booking_id=b.id,succeeded_at=clock_timestamp()
        FROM bookings b WHERE b.reservation_id=p.reservation_id`, []);
      // A selective expiry population and a larger non-active history population.
      await long(`INSERT INTO reservations(user_id,show_id,total_minor,currency,created_at,expires_at)
        SELECT $1,$2,75000,'INR',at,at+interval '5 minutes' FROM generate_series(1,100) n
        CROSS JOIN LATERAL(SELECT clock_timestamp()-interval '6 minutes'-n*interval '1 second' AS at) stamp`, [person.id, f.show]);
      await long(`INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency)
        SELECT id,show_id,$1,75000,'INR' FROM reservations WHERE sealed_at IS NULL`, [f.seat]);
      await long('UPDATE reservations SET sealed_at=clock_timestamp() WHERE sealed_at IS NULL', []);
    }, { queryTimeout: 120000 });
    const tables = ['events', 'shows', 'show_seats', 'venues', 'venue_seats', 'venue_sections', 'reservations', 'bookings', 'booking_items', 'payment_attempts', 'refunds', 'outbox_events', 'ticket_checkins'];
    for (const table of tables) await c.pool.query('ANALYZE ' + table);
    report.dataset = (await c.pool.query(`SELECT (SELECT count(*)::int FROM show_seats) AS "showSeats",
      (SELECT count(*)::int FROM shows) AS shows,(SELECT count(*)::int FROM bookings) AS bookings,
      (SELECT count(*)::int FROM reservations WHERE status='ACTIVE') AS "expiredAgreements"`)).rows[0];
    assert.equal(report.dataset.showSeats, shows * seats); assert.equal(report.dataset.bookings, histories);
    const queries = [];
    const capture = name => ({ query: async (sql, values) => { queries.push({ name, sql, values }); return c.pool.query(sql, values); } });
    await discoverEvents(capture('discovery'), { limit: 20 });
    await publicSeats(capture('seat-map'), f.event, f.show);
    await readOperationsSummary(capture('organizer-summary'), { show: { id: f.show }, organization: { role: 'OWNER' } });
    queries.push({ name: 'expiry-candidates', sql: `SELECT id FROM reservations WHERE status='ACTIVE' AND expires_at<=statement_timestamp() ORDER BY expires_at,id LIMIT $1`, values: [20] });
    // Capture the history SELECT from the actual authenticated route rather than
    // maintaining a second copy of its projection and joins.
    const recording = {
      query: (...args) => c.pool.query(...args),
      connect: async () => {
        const db = await c.pool.connect();
        return { release: (...args) => db.release(...args), query: (sql, values) => {
          if (typeof sql === 'string' && sql.includes('FROM bookings b JOIN shows')) queries.push({ name: 'booking-history', sql, values });
          return db.query(sql, values);
        } };
      }
    };
    const server = createApp({ pool: recording, config: c.config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
    c.servers.push(server);
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    c.origins.push(`http://127.0.0.1:${server.address().port}`);
    const response = await c.request(person, '/api/bookings', { api: c.origins.length - 1 }); assert.equal(response.status, 200);
    assert.equal((await response.json()).items.length, 20); assert.equal(queries.length, 5);
    const names = ['events_discovery_idx', 'shows_event_start_idx', 'reservations_expiry_idx', 'bookings_user_history_idx', 'bookings_show_history_idx', 'payment_attempts_show_reporting_idx'];
    report.comparedIndexes = (await c.pool.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname=ANY($2::text[]) ORDER BY indexname', [c.schema, names])).rows;
    assert.equal(report.comparedIndexes.length, names.length);
    const db = await c.pool.connect();
    try {
      for (const query of queries) {
        const comparison = { name: query.name, sql: query.sql, variants: [] }; report.comparisons.push(comparison);
        // Alternate order between queries to reduce a systematic warm-cache bias.
        for (const indexed of (queries.indexOf(query) % 2 ? [true, false] : [false, true])) {
          await db.query('BEGIN');
          try {
            if (!indexed) for (const name of names) await db.query(`DROP INDEX "${c.schema}"."${name}"`);
            const plans = [];
            for (let i = 0; i <= repeats; i++) {
              const result = await db.query({ text: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.sql, values: query.values, query_timeout: 120000 });
              if (i) plans.push(result.rows[0]['QUERY PLAN'][0]); // Exclude one warm-up.
            }
            comparison.variants.push({ indexed, execution: distribution(plans.map(p => p['Execution Time'])),
              planning: distribution(plans.map(p => p['Planning Time'])), plans });
          } finally { await db.query('ROLLBACK'); } // Restore every private-schema index.
        }
      }
    } finally { db.release(); }
  }); report.passed = true;
} catch { process.exitCode = 1; console.error('Query measurement failed; no performance conclusion can be drawn.'); }
finally { report.finishedAt = new Date().toISOString(); await writeEvidence('queries', report); }
