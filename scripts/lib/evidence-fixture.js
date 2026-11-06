import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { paymentFixture } from '../../tests/helpers/payment-fixture.js';
import { createTelemetry } from '../../apps/api/src/observability.js';

// Verification only: all application connections use a new private schema.
// Never migrate, seed, reset, stop or modify the user's public application data.
export async function evidenceFixture(work, { apiCount = 1, logger = { info() {}, error() {} }, traceSampleRate = 0 } = {}) {
  assert.ok(Number.isInteger(apiCount) && apiCount >= 1 && apiCount <= 2);
  const database = readDatabaseConfig().DATABASE_URL;
  const adminPool = createPool(database), pools = [], servers = [], backendPids = new Set();
  const schema = 'auth_test_' + randomUUID().replaceAll('-', '');
  assert.match(schema, /^auth_test_[a-f0-9]{32}$/);
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'),
    SIMULATOR_WEBHOOK_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: 'http://127.0.0.1' };
  let admin, primaryError;
  try {
    admin = await adminPool.connect();
    await admin.query('BEGIN');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query('SELECT set_config($1,$2,false)', ['search_path', schema + ',public']);
    const directory = new URL('../../db/migrations/', import.meta.url);
    const migrations = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const name of migrations) await admin.query(await readFile(new URL(name, directory), 'utf8'));
    await admin.query('COMMIT');
    const url = new URL(database); url.searchParams.set('options', `-c search_path=${schema},public`);
    // A separate worker pool avoids consuming an API's bounded pool slots.
    for (let i = 0; i <= apiCount; i++) {
      const pool = createPool(url.toString());
      pool.on('connect', client => backendPids.add(client.processID));
      pool.on('remove', client => backendPids.delete(client.processID)); pools.push(pool);
    }
    for (let i = 0; i < apiCount; i++) {
      const server = createApp({ pool: pools[i], config, logger, telemetry: createTelemetry({ logger, sampleRate: traceSampleRate }) }).listen(0, '127.0.0.1');
      servers.push(server);
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    }
    const pool = pools.at(-1), origins = servers.map(server => `http://127.0.0.1:${server.address().port}`);
    const tx = async (work, { queryTimeout = 2000 } = {}) => {
      assert.ok(Number.isInteger(queryTimeout) && queryTimeout >= 2000 && queryTimeout <= 120000);
      const db = await pool.connect();
      try { await db.query('BEGIN'); const value = await work(db); await db.query({ text: 'COMMIT', query_timeout: queryTimeout }); return value; }
      catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    };
    async function actor(existingId) {
      const id = existingId || randomUUID(), token = newToken(), csrf = csrfFor(token, config.AUTH_SECRET);
      if (existingId) await pool.query("UPDATE users SET status='ACTIVE',password_hash='test-session-fixture' WHERE id=$1", [id]);
      else await pool.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,'Evidence fixture','test-session-fixture')", [id, id + '@example.invalid']);
      await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [id, digest(token), digest(csrf)]);
      return { id, token, csrf };
    }
    async function catalogue(title = 'Evidence ' + randomUUID()) {
      return tx(async db => {
        const f = await paymentFixture(db);
        const meta = (await db.query('SELECT event_id AS event,organizer_id AS org,venue_id AS venue FROM shows WHERE id=$1', [f.show])).rows[0];
        await db.query("UPDATE organizers SET status='APPROVED',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1", [meta.org, f.user]);
        await db.query("UPDATE events SET status='PUBLISHED',title=$2 WHERE id=$1", [meta.event, title]);
        await db.query("UPDATE shows SET starts_at=clock_timestamp()+interval '7 days',base_price_minor=75000,currency='INR' WHERE id=$1", [f.show]);
        return { ...meta, show: f.show, seat: f.seat, user: f.user, title };
      });
    }
    async function addSeats(f, count) {
      assert.ok(Number.isInteger(count) && count >= 1 && count <= 500);
      const section = (await pool.query('SELECT section_id FROM venue_seats WHERE id=$1', [f.seat])).rows[0].section_id;
      if (count > 1) await tx(async db => {
        await db.query(`INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number)
          SELECT $1,$2,'A',n FROM generate_series(2,$3::int) n`, [f.venue, section, count]);
        await db.query(`INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor,currency)
          SELECT $1,id,venue_id,75000,'INR' FROM venue_seats WHERE venue_id=$2 AND id<>$3`, [f.show, f.venue, f.seat]);
      });
      return (await pool.query('SELECT venue_seat_id AS id FROM show_seats WHERE show_id=$1 ORDER BY venue_seat_id', [f.show])).rows.map(row => row.id);
    }
    async function request(who, path, { method = 'GET', body, key = randomUUID(), api = 0 } = {}) {
      return fetch(origins[api] + path, { method, signal: AbortSignal.timeout(15000), headers: {
        Cookie: 'seatledger_session=' + who.token, ...(method === 'GET' ? {} : {
          'Content-Type': 'application/json', Origin: config.PUBLIC_ORIGIN, 'X-SeatLedger-Client': 'web',
          'X-CSRF-Token': who.csrf, 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    await work({ pool, pools, servers, origins, config, schema, migrations, tx, actor, catalogue, addSeats, request, backendPids, connectionString: url.toString() });
  } catch (error) { primaryError = error; throw error; }
  finally {
    const cleanupErrors = [];
    const clean = async work => { try { await work(); } catch (error) { cleanupErrors.push(error); } };
    for (const server of servers) await clean(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    for (const pool of pools) await clean(() => pool.end());
    if (admin) {
      await clean(() => admin.query('ROLLBACK'));
      await clean(() => admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
      admin.release();
    }
    await clean(() => adminPool.end());
    if (cleanupErrors.length && !primaryError) throw new Error('Private evidence fixture cleanup failed');
  }
}
