export const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(value + 'T00:00:00Z');
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
export function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return calendarDay(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24 &&
    Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value));
}
const filterLimits = { q: 120, city: 120, category: 60, from: 10, to: 10 };
export function readSearch(search = '', programme = false) {
  const params = new URLSearchParams(search), filters = {};
  const allowed = programme ? ['after'] : [...Object.keys(filterLimits), 'after'];
  let valid = true;
  for (const [key, raw] of params) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) { valid = false; continue; }
    if (key === 'after') { if (!validId(raw)) valid = false; continue; }
    const value = raw.trim(); filters[key] = value;
    if (!value || value.length > filterLimits[key]) valid = false;
    if (['from', 'to'].includes(key) && (!calendarDay(value) || value < '2000-01-01' || value > '2100-12-31')) valid = false;
  }
  if (filters.from && filters.to && filters.from > filters.to) valid = false;
  return { valid, filters, cursor: params.get('after') || null };
}
export function searchFor(filters = {}, cursor = null) {
  const params = new URLSearchParams();
  for (const key of Object.keys(filterLimits)) if (filters[key]?.trim()) params.set(key, filters[key].trim());
  if (cursor) params.set('after', cursor);
  return params.toString();
}
export function venueWhen(show) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: show.venue.timezone }).format(new Date(show.startsAt));
}
export function utcWhen(value) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
}
export function priceLabel(amount, currency) {
  // These currencies have two decimal minor units. Do not assume that every
  // imported three-letter currency uses paise/cents (JPY, KWD, unknown codes).
  if (['INR', 'USD', 'EUR', 'GBP'].includes(currency)) return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(amount / 100);
  return `${amount.toLocaleString('en-IN')} minor units (${currency})`;
}
export const stateLabels = { AVAILABLE: 'Available', HELD: 'Held', BOOKED: 'Booked' };
export function seatingSections(seats) {
  const sections = new Map();
  for (const seat of seats) {
    if (!sections.has(seat.sectionId)) sections.set(seat.sectionId, { id: seat.sectionId, name: seat.section, rows: new Map() });
    const section = sections.get(seat.sectionId);
    if (!section.rows.has(seat.row)) section.rows.set(seat.row, []);
    section.rows.get(seat.row).push(seat);
  }
  return [...sections.values()].map(section => ({ ...section, rows: [...section.rows].map(([label, cells]) => ({ label, cells })) }));
}
