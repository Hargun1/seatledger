import { HttpError } from '../http-error.js';
import { titlePattern } from './policy.js';

// These are fixed SQL fragments, never request strings. Every public path
// checks the same visibility in the statement that reads the returned data.
const eventVisible = "e.status='PUBLISHED' AND o.status='APPROVED'";
const showVisible = `s.status='SCHEDULED' AND s.starts_at>statement_timestamp()
  AND EXISTS(SELECT 1 FROM show_seats stock WHERE stock.show_id=s.id)`;
const showFields = `s.id,s.starts_at AS "startsAt",v.id AS "venueId",
  v.name AS "venueName",v.city,v.timezone`;
const eventFields = `e.id,e.title,e.category`;
const page = (rows, limit) => ({ items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
const show = row => ({ id: row.id, startsAt: row.startsAt,
  venue: { id: row.venueId, name: row.venueName, city: row.city, timezone: row.timezone } });

async function query(pool, sql, values) {
  try { return await pool.query(sql, values); }
  catch (error) {
    if (/^(08|53|57P)/.test(error.code ?? '') || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57014'].includes(error.code) ||
        ['Query read timeout', 'Connection terminated unexpectedly', 'timeout exceeded when trying to connect'].includes(error.message)) {
      throw new HttpError(503, 'CATALOG_UNAVAILABLE');
    }
    throw error; // Global handler sanitizes unexpected errors; no raw SQL sent.
  }
}

export async function discoverEvents(pool, input) {
  const { limit, after, q, city, category, from, to } = input;
  const result = await query(pool, `SELECT ${eventFields},first_show.*
    FROM events e JOIN organizers o ON o.id=e.organizer_id
    JOIN LATERAL (
      SELECT s.id AS "showId",s.starts_at AS "startsAt",v.id AS "venueId",v.name AS "venueName",v.city,v.timezone
      FROM shows s JOIN venues v ON v.id=s.venue_id
      WHERE s.event_id=e.id AND ${showVisible}
        AND ($4::text IS NULL OR lower(v.city)=lower($4))
        AND ($6::timestamptz IS NULL OR s.starts_at >= $6::timestamptz)
        AND ($7::timestamptz IS NULL OR s.starts_at < $7::timestamptz + interval '24 hours')
      ORDER BY s.starts_at,s.id LIMIT 1
    ) first_show ON true
    WHERE ${eventVisible} AND ($1::uuid IS NULL OR e.id>$1)
      AND ($3::text IS NULL OR e.title ILIKE $3 ESCAPE E'\\\\')
      AND ($5::text IS NULL OR lower(e.category)=lower($5))
    ORDER BY e.id LIMIT $2`, [after ?? null, limit + 1, titlePattern(q), city ?? null, category ?? null,
    from ? from + 'T00:00:00Z' : null, to ? to + 'T00:00:00Z' : null]);
  return { ...page(result.rows.map(row => ({ id: row.id, title: row.title, category: row.category,
    nextShow: show({ ...row, id: row.showId }) })), limit), paymentMode: 'simulated' };
}

export async function publicEvent(pool, eventId, { after, limit }) {
  // One statement/snapshot: no separate authorization read followed by an
  // unguarded catalogue read. A missing eligible show hides the whole event.
  const result = await query(pool, `SELECT ${eventFields},programme.items
    FROM events e JOIN organizers o ON o.id=e.organizer_id
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(to_jsonb(selected) ORDER BY selected.id) AS items FROM (
        SELECT ${showFields} FROM shows s JOIN venues v ON v.id=s.venue_id
        WHERE s.event_id=e.id AND ${showVisible} AND ($2::uuid IS NULL OR s.id>$2)
        ORDER BY s.id LIMIT $3
      ) selected
    ) programme
    WHERE e.id=$1 AND ${eventVisible}
      AND EXISTS(SELECT 1 FROM shows s WHERE s.event_id=e.id AND ${showVisible})`, [eventId, after ?? null, limit + 1]);
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  return { event: { id: row.id, title: row.title, category: row.category },
    shows: page((row.items ?? []).map(show), limit), paymentMode: 'simulated' };
}

export async function publicSeats(pool, eventId, showId) {
  const result = await query(pool, `SELECT e.id AS "eventId",e.title,e.category,${showFields},
      statement_timestamp() AS "asOf",seats.items,
      (SELECT count(*)::int FROM (SELECT 1 FROM venue_seats WHERE venue_id=v.id LIMIT 501) layout) AS "physicalCount"
    FROM shows s JOIN events e ON e.id=s.event_id JOIN organizers o ON o.id=e.organizer_id
    JOIN venues v ON v.id=s.venue_id
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(to_jsonb(selected) ORDER BY selected."sectionId",selected.row,selected.number,selected.id) AS items FROM (
        SELECT stock.venue_seat_id AS id,section.id AS "sectionId",section.name AS section,
          physical.row_label AS "row",physical.seat_number AS number,stock.state,
          stock.price_minor AS "priceMinor",stock.currency
        FROM show_seats stock JOIN venue_seats physical ON physical.id=stock.venue_seat_id
          JOIN venue_sections section ON section.id=physical.section_id
        WHERE stock.show_id=s.id
        ORDER BY section.id,physical.row_label,physical.seat_number,physical.id LIMIT 501
      ) selected
    ) seats
    WHERE e.id=$1 AND s.id=$2 AND ${eventVisible} AND ${showVisible}`, [eventId, showId]);
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  // Never silently draw a truncated map as complete. Published API inventory
  // is capped at 500; an oversized legacy/imported catalogue needs maintenance.
  if (!row.items?.length || row.items.length > 500 || row.physicalCount !== row.items.length) throw new HttpError(503, 'INVENTORY_UNAVAILABLE');
  return { event: { id: row.eventId, title: row.title, category: row.category }, show: show(row),
    seats: row.items, asOf: row.asOf, advisory: true, readOnly: true, paymentMode: 'simulated' };
}
