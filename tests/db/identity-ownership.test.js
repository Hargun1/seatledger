import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';

test('identity, sessions and organizer ownership (real PostgreSQL)', async t => {
  const pool = createPool(readConfig().DATABASE_URL);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const user = randomUUID();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const venueA = randomUUID();
    const venueB = randomUUID();
    const eventA = randomUUID();
    const eventB = randomUUID();
    const email = `${user}@tests.seatledger.invalid`;
    await client.query('INSERT INTO users (id,email,display_name,status) VALUES ($1,$2,$3,$4)', [user, email, 'Constraint test user', 'DISABLED']);
    await client.query('INSERT INTO organizers (id,name) VALUES ($1,$2),($3,$4)', [orgA, 'Test A', orgB, 'Test B']);
    await client.query('INSERT INTO venues (id,name,city,organizer_id) VALUES ($1,$2,$3,$4),($5,$6,$3,$7)', [venueA, 'Venue A', 'Test City', orgA, venueB, 'Venue B', orgB]);
    await client.query('INSERT INTO events (id,title,category,organizer_id) VALUES ($1,$2,$3,$4),($5,$6,$3,$7)', [eventA, 'Event A', 'Talks', orgA, eventB, 'Event B', orgB]);
    await client.query('INSERT INTO shows (event_id,venue_id,organizer_id,starts_at) VALUES ($1,$2,$3,$4)', [eventA, venueA, orgA, '2030-01-01T18:00:00Z']);

    // An expected SQL error aborts the current transaction. A savepoint lets
    // each case recover without committing any fixture or invalid write.
    async function rejected(sql, values, code, constraint) {
      await client.query('SAVEPOINT invalid_write');
      try {
        await assert.rejects(client.query(sql, values), error =>
          error.code === code && (!constraint || error.constraint === constraint));
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT invalid_write');
        await client.query('RELEASE SAVEPOINT invalid_write');
      }
    }

    await t.test('normalized email is required and duplicates are rejected', async () => {
      await rejected('INSERT INTO users (email,display_name,status) VALUES ($1,$2,$3)', [email, 'Duplicate', 'DISABLED'], '23505');
      await rejected('INSERT INTO users (email,display_name,status) VALUES ($1,$2,$3)', [email.toUpperCase(), 'Mixed case', 'DISABLED'], '23514', 'users_normalized_email');
    });
    await t.test('active users require a password hash; disabled fixtures need no password', async () => {
      await rejected('UPDATE users SET status=$1 WHERE id=$2', ['ACTIVE', user], '23514', 'users_password_required');
      assert.equal((await client.query('SELECT password_hash FROM users WHERE id=$1', [user])).rows[0].password_hash, null);
    });
    await t.test('sessions require an existing user and fixed-length token hashes', async () => {
      const sql = 'INSERT INTO sessions (user_id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval \'1 hour\')';
      await rejected(sql, [randomUUID(), randomBytes(32), randomBytes(32)], '23503');
      await rejected(sql, [user, Buffer.from('raw-session-token'), randomBytes(32)], '23514');
    });
    await t.test('duplicate token hashes and invalid session lifetimes are rejected', async () => {
      const hash = randomBytes(32);
      const sql = 'INSERT INTO sessions (user_id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval \'1 hour\')';
      await client.query(sql, [user, hash, randomBytes(32)]);
      await rejected(sql, [user, hash, randomBytes(32)], '23505');
      await rejected('INSERT INTO sessions (user_id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,$4)', [user, randomBytes(32), randomBytes(32), '2000-01-01T00:00:00Z'], '23514', 'sessions_valid_times');
    });
    await t.test('approval requires a complete approver/time pair', async () => {
      await rejected('UPDATE organizers SET status=$1 WHERE id=$2', ['APPROVED', orgA], '23514', 'organizers_approval_state');
      await rejected('UPDATE organizers SET approved_at=clock_timestamp() WHERE id=$1', [orgA], '23514', 'organizers_approval_pair');
    });
    await t.test('memberships reject duplicates and nonexistent users', async () => {
      await client.query('INSERT INTO organizer_memberships (organizer_id,user_id,role) VALUES ($1,$2,$3)', [orgA, user, 'OWNER']);
      await rejected('INSERT INTO organizer_memberships (organizer_id,user_id) VALUES ($1,$2)', [orgA, user], '23505');
      await rejected('INSERT INTO organizer_memberships (organizer_id,user_id) VALUES ($1,$2)', [orgA, randomUUID()], '23503');
    });
    await t.test('events and venues must reference an actual organizer', async () => {
      await rejected('INSERT INTO events (title,category,organizer_id) VALUES ($1,$2,$3)', ['No owner', 'Talks', null], '23502');
      await rejected('INSERT INTO venues (name,city,organizer_id) VALUES ($1,$2,$3)', ['Wrong owner', 'Test City', randomUUID()], '23503');
    });
    await t.test('a show cannot borrow another organizer\'s event or venue', async () => {
      const sql = 'INSERT INTO shows (event_id,venue_id,organizer_id,starts_at) VALUES ($1,$2,$3,$4)';
      await rejected(sql, [eventB, venueA, orgA, '2030-01-01T18:00:00Z'], '23503', 'shows_event_owner_fk');
      await rejected(sql, [eventA, venueB, orgA, '2030-01-01T18:00:00Z'], '23503', 'shows_venue_owner_fk');
    });
    await t.test('ownership edits cannot strand an existing show', async () => {
      await rejected('UPDATE venues SET organizer_id=$1 WHERE id=$2', [orgB, venueA], '23503', 'shows_venue_owner_fk');
      await rejected('UPDATE events SET organizer_id=$1 WHERE id=$2', [orgB, eventA], '23503', 'shows_event_owner_fk');
    });
    await t.test('imported catalog starts pending with no members', async () => {
      const id = '40000000-0000-4000-8000-000000000000';
      assert.equal((await client.query('SELECT status FROM organizers WHERE id=$1', [id])).rows[0].status, 'PENDING');
      assert.equal((await client.query('SELECT count(*)::int AS count FROM organizer_memberships WHERE organizer_id=$1', [id])).rows[0].count, 0);
    });
  } finally {
    try { if (client) { try { await client.query('ROLLBACK'); } finally { client.release(); } } }
    finally { await pool.end(); }
  }
});
