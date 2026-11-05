import { lockShowGate, lockShowSeats } from './service.js';

// One candidate per transaction. The preliminary read is discovery, not a
// parent lock/claim. Catalogue gates always precede sorted inventory locks.
async function expireOne(db, id) {
  const row = (await db.query('SELECT show_id FROM reservations WHERE id=$1', [id])).rows[0];
  if (!row) return { expired: false, releasedSeats: 0 };
  await lockShowGate(db, row.show_id, false); // Suspension/cancellation must not trap expired stock.
  const items = (await db.query('SELECT venue_seat_id FROM reservation_items WHERE reservation_id=$1 ORDER BY venue_seat_id', [id])).rows;
  const locked = await lockShowSeats(db, row.show_id, items.map(item => item.venue_seat_id));
  if (items.length < 1 || items.length > 8 || locked.length !== items.length) throw new Error('Invalid expiry agreement');
  await db.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE', [id]);
  // A separate statement AFTER parent/inventory locks uses fresh DB wall time.
  const closed = await db.query(`UPDATE reservations SET status='EXPIRED',closed_at=clock_timestamp()
    WHERE id=$1 AND status='ACTIVE' AND expires_at<=clock_timestamp() RETURNING id`, [id]);
  if (!closed.rowCount) return { expired: false, releasedSeats: 0 };
  const released = await db.query(`UPDATE show_seats SET state='AVAILABLE',reservation_id=NULL,booking_id=NULL,expires_at=NULL
    WHERE show_id=$1 AND reservation_id=$2 AND state='HELD'`, [row.show_id, id]);
  return { expired: true, releasedSeats: released.rowCount };
}

export async function runExpiryBatch(pool, { batchSize = 20, signal } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new TypeError('Expiry batch size must be 1..100');
  const counts = { selected: 0, attempted: 0, expired: 0, releasedSeats: 0, skipped: 0, busy: 0, failed: 0 };
  if (signal?.aborted) return counts;
  // Advisory indexable candidate selection: NO parent FOR UPDATE/SKIP LOCKED.
  const candidates = (await pool.query(`SELECT id FROM reservations WHERE status='ACTIVE' AND expires_at<=statement_timestamp()
    ORDER BY expires_at,id LIMIT $1`, [batchSize])).rows;
  counts.selected = candidates.length;
  for (const candidate of candidates) {
    if (signal?.aborted) break;
    let db, discard = false;
    counts.attempted++; // Includes a failed connection acquisition.
    try {
      db = await pool.connect();
      if (signal?.aborted) break;
      await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await db.query('SELECT set_config($1,$2,true),set_config($3,$4,true)',
        ['lock_timeout', '250ms', 'statement_timeout', '1500ms']);
      const result = await expireOne(db, candidate.id);
      await db.query('COMMIT');
      if (result.expired) { counts.expired++; counts.releasedSeats += result.releasedSeats; }
      else counts.skipped++;
    } catch (error) {
      if (db) await db.query('ROLLBACK').catch(() => { discard = true; });
      discard ||= error.code?.startsWith('08') || error.message === 'Query read timeout';
      if (['55P03', '40P01', '40001', '57014'].includes(error.code)) counts.busy++;
      else counts.failed++;
      // No raw error/connection/customer data is logged. Retry is a later poll;
      // a successful-but-unacknowledged commit is discovered by stored state.
    } finally { db?.release(discard ? new Error('Expiry connection unavailable') : undefined); }
  }
  return counts;
}
