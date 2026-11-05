import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';
import { seedDevelopment } from '../../scripts/lib/seeds.js';
import { discoveryRequest } from '../../apps/web/src/discovery/client.js';

test('public discovery, event programme and advisory seats use real PostgreSQL', { timeout: 30000 }, async t => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original);
  let admin, schema, pool, server, base, org, user, venue;
  const ids = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const path = e => `/events/${e.id}`, seatPath = (e, s = e.shows[0]) => `${path(e)}/shows/${s.id}/seats`;
  async function get(path, expected = 200) {
    const response = await fetch(base + '/api' + path);
    assert.equal(response.status, expected, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json();
  }
  async function event(n, { status = 'PUBLISHED', title = 'Evening talk', category = 'Talks', owner = org.id,
    starts = ['2090-06-10T18:30:00Z'], stock = true, showStatus = 'SCHEDULED', atVenue = venue } = {}) {
    const e = (await pool.query('INSERT INTO events(id,title,category,status,organizer_id) VALUES($1,$2,$3,$4,$5) RETURNING id', [ids(n), title, category, status, owner])).rows[0]; e.shows = [];
    for (const startsAt of starts) {
      const s = (await pool.query('INSERT INTO shows(event_id,venue_id,organizer_id,starts_at,status) VALUES($1,$2,$3,$4,$5) RETURNING id', [e.id, atVenue.id, owner, startsAt, showStatus])).rows[0]; e.shows.push(s);
      if (stock) await pool.query("INSERT INTO show_seats(show_id,venue_id,venue_seat_id,price_minor,currency) SELECT $1,$2,id,45000,'INR' FROM venue_seats WHERE venue_id=$2", [s.id, atVenue.id]);
    }
    return e;
  }
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql', '009_draft_shows.sql', '010_event_publication.sql']) await admin.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await admin.query('COMMIT'); const url = new URL(original); url.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(url.toString());
    server = createApp({ pool, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); }); base = `http://127.0.0.1:${server.address().port}`;
    user = (await pool.query("INSERT INTO users(email,display_name,password_hash) VALUES($1,'Discovery fixture','fixture-not-a-login-password') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0];
    org = (await pool.query("INSERT INTO organizers(name,status,approved_by,approved_at) VALUES('Discovery fixture','APPROVED',$1,clock_timestamp()) RETURNING id", [user.id])).rows[0];
    venue = (await pool.query("INSERT INTO venues(name,city,organizer_id) VALUES('Lantern','Bengaluru',$1) RETURNING id", [org.id])).rows[0];
    const section = (await pool.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [venue.id])).rows[0];
    await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) SELECT $1,$2,'A',n FROM generate_series(1,3) n", [venue.id, section.id]);
    const a = await event(1, { title: 'Jazz 50%_\\', category: 'Music', starts: ['2090-06-10T00:00:00Z', '2090-06-11T00:00:00Z'] }), b = await event(2);

    await t.test('anonymous reads expose only approved, published, future scheduled stock', async () => {
      // The production frontend transport against real HTTP and PostgreSQL.
      // This synthetic relative-URL adapter is not browser/React execution.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => originalFetch(typeof url === 'string' && url.startsWith('/api/') ? base + url : url, options);
      try {
        const list = await discoveryRequest('events', { search: 'q=Jazz&city=Bengaluru&category=Music' });
        assert.equal(list.items[0].id, a.id);
        const detail = await discoveryRequest('event', { eventId: a.id }); assert.equal(detail.shows.items.length, 2);
        const map = await discoveryRequest('seats', { eventId: a.id, showId: a.shows[0].id }); assert.equal(map.seats.length, 3); assert.equal(map.seats[0].currency, 'INR');
      } finally { globalThis.fetch = originalFetch; }
      const hidden = [await event(10, { status: 'DRAFT' }), await event(11, { status: 'CANCELLED' }),
        await event(12, { starts: ['2001-01-01T00:00:00Z'] }), await event(13, { stock: false }),
        await event(14, { showStatus: 'CANCELLED' }), await event(15, { showStatus: 'COMPLETED' })];
      assert.deepEqual((await get('/events')).items.map(e => e.id), [a.id, b.id]);
      for (const e of hidden) { await get(path(e), 404); await get(seatPath(e), 404); }
      for (const status of ['SUSPENDED', 'PENDING']) {
        if (status === 'PENDING') await pool.query("UPDATE organizers SET status='PENDING',approved_by=NULL,approved_at=NULL WHERE id=$1", [org.id]);
        else await pool.query('UPDATE organizers SET status=$1 WHERE id=$2', [status, org.id]);
        assert.deepEqual((await get('/events')).items, []); await get(path(a), 404); await get(seatPath(a), 404);
      }
      await pool.query("UPDATE organizers SET status='APPROVED',approved_by=$1,approved_at=clock_timestamp() WHERE id=$2", [user.id, org.id]);
      await get(`${path(a)}/shows/${b.shows[0].id}/seats`, 404);
    });
    await t.test('filters intersect on the same show, UTC day ends and wildcard literals are exact', async () => {
      const filter = new URLSearchParams({ q: '50%_\\', city: 'bEnGaLuRu', category: 'music', from: '2090-06-10', to: '2090-06-10' });
      const rows = (await get('/events?' + filter)).items; assert.deepEqual(rows.map(e => e.id), [a.id]); assert.equal(Date.parse(rows[0].nextShow.startsAt), Date.parse('2090-06-10T00:00:00Z'));
      assert.deepEqual((await get('/events?city=Delhi&from=2090-06-10')).items, []);
      assert.deepEqual((await get('/events?q=' + encodeURIComponent("' OR 1=1 --"))).items, []);
      assert.deepEqual((await get('/events?category=Music&from=2090-06-11&to=2090-06-11')).items.map(e => e.id), [a.id]);
      assert.deepEqual((await get('/events?category=Music&from=2090-06-12')).items, []);
      const delhi = (await pool.query("INSERT INTO venues(name,city,organizer_id) VALUES('Other','Delhi',$1) RETURNING id", [org.id])).rows[0];
      const mixed = await event(3, { starts: ['2090-06-12T12:00:00Z'] });
      const extra = (await pool.query("INSERT INTO shows(event_id,venue_id,organizer_id,starts_at) VALUES($1,$2,$3,'2090-06-10T12:00:00Z') RETURNING id", [mixed.id, delhi.id, org.id])).rows[0];
      const sec = (await pool.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [delhi.id])).rows[0];
      const seat = (await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) VALUES($1,$2,'A',1) RETURNING id", [delhi.id, sec.id])).rows[0];
      await pool.query("INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor,currency) VALUES($1,$2,$3,0,'INR')", [extra.id, seat.id, delhi.id]);
      assert.equal((await get('/events?city=Bengaluru&to=2090-06-10')).items.some(e => e.id === mixed.id), false);
    });
    await t.test('bounded UUID pages and invalid input are handled without private fields', async () => {
      const first = await get('/events?limit=1'); assert.equal(first.items[0].id, a.id); assert.equal(first.nextCursor, a.id);
      assert.equal((await get('/events?limit=1&after=' + first.nextCursor)).items[0].id, b.id);
      const detail = await get(path(a) + '?limit=1'); assert.equal(detail.shows.items.length, 1); assert.ok(detail.shows.nextCursor);
      const next = await get(path(a) + '?limit=1&after=' + detail.shows.nextCursor); assert.equal(next.shows.items.length, 1); assert.equal(next.shows.nextCursor, null);
      assert.notEqual(next.shows.items[0].id, detail.shows.items[0].id);
      for (const suffix of ['?limit=51', '?from=2090-02-30', '?city=a&city=b', '?status=DRAFT', '?q=']) await get('/events' + suffix, 400);
      await get('/events/not-a-uuid', 404); await get(seatPath(a) + '?include=customer', 400);
      assert.deepEqual(Object.keys(detail.event).sort(), ['category', 'id', 'title']);
    });
    await t.test('map reads saved prices and HELD state without exposing ownership or changing inventory', async () => {
      const showId = a.shows[0].id, seat = (await pool.query('SELECT venue_seat_id FROM show_seats WHERE show_id=$1 ORDER BY venue_seat_id LIMIT 1', [showId])).rows[0];
      const db = await pool.connect(); let r;
      try {
        await db.query('BEGIN');
        r = (await db.query("INSERT INTO reservations(user_id,show_id,currency,total_minor) VALUES($1,$2,'INR',45000) RETURNING id", [user.id, showId])).rows[0];
        await db.query("INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES($1,$2,$3,45000,'INR')", [r.id, showId, seat.venue_seat_id]);
        await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1', [r.id]);
        // Copy expiry in SQL: JavaScript Date truncates PostgreSQL microseconds
        // and would violate the deliberately exact composite expiry FK.
        await db.query("UPDATE show_seats stock SET state='HELD',reservation_id=r.id,expires_at=r.expires_at FROM reservations r WHERE r.id=$1 AND stock.show_id=$2 AND stock.venue_seat_id=$3", [r.id, showId, seat.venue_seat_id]);
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
      finally { db.release(); }
      const before = (await pool.query('SELECT * FROM show_seats WHERE show_id=$1 ORDER BY venue_seat_id', [showId])).rows;
      const map = await get(seatPath(a)); assert.equal(map.seats.length, 3); assert.equal(map.advisory, true); assert.equal(map.readOnly, true); assert.equal(map.paymentMode, 'simulated'); assert.ok(Number.isFinite(Date.parse(map.asOf)));
      assert.equal(map.seats.find(s => s.id === seat.venue_seat_id).state, 'HELD');
      for (const cell of map.seats) { assert.equal(cell.priceMinor, 45000); assert.equal(cell.currency, 'INR'); assert.deepEqual(Object.keys(cell).sort(), ['currency', 'id', 'number', 'priceMinor', 'row', 'section', 'sectionId', 'state']); }
      const text = JSON.stringify(map); for (const privateValue of [user.id, org.id, r.id, 'publication_token', 'expires_at', 'password_hash']) assert.equal(text.includes(privateValue), false);
      assert.deepEqual((await pool.query('SELECT * FROM show_seats WHERE show_id=$1 ORDER BY venue_seat_id', [showId])).rows, before);
      // Partial legacy stock must not be silently drawn as a complete layout.
      const broken = await event(4);
      await pool.query('DELETE FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2', [broken.shows[0].id, seat.venue_seat_id]);
      assert.deepEqual(await get(seatPath(broken), 503), { error: 'INVENTORY_UNAVAILABLE' });
      const large = await event(5);
      await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) SELECT $1,$2,'B',n FROM generate_series(1,498) n", [venue.id, section.id]);
      await pool.query("INSERT INTO show_seats(show_id,venue_id,venue_seat_id,price_minor,currency) SELECT $1,$2,id,0,'INR' FROM venue_seats WHERE venue_id=$2 ON CONFLICT DO NOTHING", [large.shows[0].id, venue.id]);
      assert.deepEqual(await get(seatPath(large), 503), { error: 'INVENTORY_UNAVAILABLE' });
    });
    await t.test('development demo is discoverable and reseeding preserves existing records and held seats', async () => {
      const env = { NODE_ENV: 'development', ALLOW_DEV_SEED: 'true' };
      await seedDevelopment(pool, env); const first = await get('/events?q=Lantern'); assert.equal(first.items.length, 1);
      const demo = first.items[0], snapshot = await get(`${path(demo)}/shows/${demo.nextShow.id}/seats`); assert.equal(snapshot.seats.length, 24);
      const counts = (await pool.query('SELECT (SELECT count(*) FROM events) AS events,(SELECT count(*) FROM show_seats) AS stock')).rows;
      const held = (await pool.query("SELECT * FROM show_seats WHERE state='HELD'")).rows;
      await seedDevelopment(pool, env); assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM events) AS events,(SELECT count(*) FROM show_seats) AS stock')).rows, counts);
      assert.deepEqual((await pool.query("SELECT * FROM show_seats WHERE state='HELD'")).rows, held);
      assert.equal((await pool.query("SELECT status FROM organizers WHERE id='40000000-0000-4000-8000-000000000000'")).rows[0].status, 'PENDING');
    });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end(); if (admin) { await admin.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } admin.release(); } await adminPool.end();
  }
});
