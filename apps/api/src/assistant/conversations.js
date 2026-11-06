import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from '../http-error.js';
import { readReservation } from '../reservations/service.js';
import { listPayments } from '../payments/service.js';
import { initialContext } from './tools.js';

export function boundedTranscript(input) {
  const messages = [...input];
  // Leave space for PostgreSQL's JSON formatting and the next confirmation.
  while (messages.length > 2 && (messages.length > 60 || Buffer.byteLength(JSON.stringify(messages)) > 64000)) messages.splice(1, 1);
  return { messages, truncated: messages.length !== input.length };
}

export async function ownedConversation(db, userId, id, lock = false) {
  const row = (await db.query(`SELECT *,clock_timestamp() AS now,
    lease_until>clock_timestamp() AS busy FROM assistant_conversations
    WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp() ${lock ? 'FOR UPDATE' : ''}`, [id,userId])).rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND'); return row;
}

export async function snapshot(db, userId, row) {
  let hold = row.context.hold;
  if (hold) {
    const current = await readReservation(db, userId, hold.id), payments = await listPayments(db, userId, hold.id);
    const paid = payments.items.find(payment => payment.bookingId);
    hold = { ...hold, ...current, bookingPath: paid ? `/account/bookings/${paid.bookingId}` : null };
  }
  const proposal = row.context.proposal;
  const pending = (await db.query(`SELECT request_key AS "requestKey",user_message AS message,base_revision AS revision,status
    FROM assistant_turns WHERE conversation_id=$1 AND user_id=$2 AND base_revision=$3 AND status<>'COMPLETED' ORDER BY created_at DESC LIMIT 1`, [row.id,userId,row.revision])).rows[0] || null;
  return { id: row.id, revision: row.revision, messages: row.messages, preferences: row.context.preferences,
    proposal: proposal ? { ...proposal, status: hold?.proposalId === proposal.id ? 'CONFIRMED'
      : new Date(proposal.expiresAt) <= row.now ? 'EXPIRED' : 'READY' } : null,
    hold, pending, historyTruncated: Boolean(row.context.historyTruncated), busy: Boolean(row.active_request_key && row.busy),
    serverNow: row.now.toISOString(), expiresAt: row.expires_at.toISOString(), paymentMode: 'simulated' };
}

export async function createConversation(db, userId, creationKey, config) {
  await db.query('DELETE FROM assistant_conversations WHERE user_id=$1 AND expires_at<=clock_timestamp()', [userId]);
  const existing = (await db.query('SELECT id FROM assistant_conversations WHERE user_id=$1 AND creation_key=$2', [userId,creationKey])).rows[0];
  if (existing) return snapshot(db, userId, await ownedConversation(db,userId,existing.id));
  const count = (await db.query("SELECT count(*)::int AS n FROM assistant_conversations WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 day'", [userId])).rows[0].n;
  if (count >= (config.AI_CONVERSATIONS_PER_DAY ?? 5)) { const error = new HttpError(429, 'AI_RATE_LIMITED'); error.retryAfter = 3600; throw error; }
  const greeting = [{ id: randomUUID(), role: 'assistant', text: 'Tell me what you would like to see, where and when, and how many seats you need. Suggestions never reserve seats; you will review a summary and confirm a hold yourself.', cards: [] }];
  const row = (await db.query(`INSERT INTO assistant_conversations(user_id,creation_key,context,messages)
    VALUES($1,$2,$3::jsonb,$4::jsonb) RETURNING *`, [userId,creationKey,JSON.stringify(initialContext()),JSON.stringify(greeting)])).rows[0];
  return snapshot(db,userId,await ownedConversation(db,userId,row.id));
}

async function consumeUsage(db, userId, config) {
  const limits = [['global','day',config.AI_GLOBAL_TURNS_PER_DAY ?? 200],['global','hour',config.AI_GLOBAL_TURNS_PER_HOUR ?? 50],
    [userId,'hour',config.AI_USER_TURNS_PER_HOUR ?? 20]];
  for (const [key,period,limit] of limits) {
    const seconds = period === 'day' ? 86400 : 3600;
    const row = (await db.query(`WITH n AS MATERIALIZED(SELECT date_trunc($2,clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS at)
      INSERT INTO assistant_usage_buckets(bucket_key,period,window_start,attempts) SELECT $1,$2,at,1 FROM n
      ON CONFLICT(bucket_key,period,window_start) DO UPDATE SET attempts=LEAST(assistant_usage_buckets.attempts+1,1000000)
      RETURNING attempts,ceil(greatest(0,extract(epoch FROM window_start+($3::int*interval '1 second')-clock_timestamp())))::int AS wait`, [key,period,seconds])).rows[0];
    if (row.attempts > limit) { const error = new HttpError(429,'AI_RATE_LIMITED'); error.retryAfter = row.wait; throw error; }
  }
}

export async function claimTurn(db, userId, conversationId, requestKey, input, config) {
  const row = await ownedConversation(db,userId,conversationId,true);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest();
  const existing = (await db.query('SELECT * FROM assistant_turns WHERE conversation_id=$1 AND request_key=$2', [conversationId,requestKey])).rows[0];
  if (existing && !existing.request_hash.equals(hash)) throw new HttpError(409,'IDEMPOTENCY_CONFLICT');
  if (existing?.status === 'COMPLETED') return { replay: await snapshot(db,userId,row) };
  if (row.revision !== input.revision) throw new HttpError(409,'ASSISTANT_CONFLICT');
  if (row.busy) throw new HttpError(409,'ASSISTANT_BUSY');
  const total = (await db.query('SELECT count(*)::int AS n FROM assistant_turns WHERE conversation_id=$1', [conversationId])).rows[0].n;
  if ((!existing && total >= 20) || existing?.attempts >= 3) throw new HttpError(429,'AI_RETRY_LIMIT');
  await consumeUsage(db,userId,config);
  if (existing) await db.query("UPDATE assistant_turns SET status='PROCESSING',attempts=attempts+1 WHERE conversation_id=$1 AND request_key=$2", [conversationId,requestKey]);
  else await db.query(`INSERT INTO assistant_turns(conversation_id,user_id,request_key,request_hash,user_message,base_revision)
    VALUES($1,$2,$3,$4,$5,$6)`, [conversationId,userId,requestKey,hash,input.message,input.revision]);
  const token = randomUUID();
  await db.query(`UPDATE assistant_conversations SET active_request_key=$2,lease_token=$3,lease_until=clock_timestamp()+interval '90 seconds'
    WHERE id=$1`, [conversationId,requestKey,token]);
  return { conversationId, userId, requestKey, token, revision: row.revision,
    state: structuredClone(row.context), history: row.messages, message: input.message };
}

export async function completeTurn(db, userId, claim, result) {
  const row = await ownedConversation(db,userId,claim.conversationId,true);
  if (row.active_request_key !== claim.requestKey || row.lease_token !== claim.token || !row.busy || row.revision !== claim.revision)
    throw new HttpError(409,'ASSISTANT_LEASE_EXPIRED');
  const transcript = boundedTranscript([...row.messages, { id: randomUUID(), role: 'user', text: claim.message, cards: [] },
    { id: randomUUID(), role: 'assistant', text: result.text, cards: result.cards, truncated: result.truncated }]);
  result.state.historyTruncated = Boolean(row.context.historyTruncated || transcript.truncated);
  await db.query(`UPDATE assistant_conversations SET context=$2::jsonb,messages=$3::jsonb,revision=revision+1,
    active_request_key=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1`, [row.id,JSON.stringify(result.state),JSON.stringify(transcript.messages)]);
  await db.query("UPDATE assistant_turns SET status='COMPLETED' WHERE conversation_id=$1 AND request_key=$2", [row.id,claim.requestKey]);
  return snapshot(db,userId,await ownedConversation(db,userId,row.id));
}

export async function failTurn(pool, claim) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const changed = await db.query(`UPDATE assistant_conversations SET active_request_key=NULL,lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND user_id=$2 AND active_request_key=$3 AND lease_token=$4 RETURNING id`, [claim.conversationId,claim.userId,claim.requestKey,claim.token]);
    if (changed.rowCount) await db.query("UPDATE assistant_turns SET status='FAILED' WHERE conversation_id=$1 AND request_key=$2", [claim.conversationId,claim.requestKey]);
    await db.query('COMMIT');
  } catch { await db.query('ROLLBACK').catch(() => {}); }
  finally { db.release(); }
}
