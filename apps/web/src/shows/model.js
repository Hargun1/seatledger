import { validZone } from '../venues/model.js';

const formatter = zone => new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
const parts = (format, ms) => Object.fromEntries(format.formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
export function wallMinute(instant, zone) {
  if (!validZone(zone) || !Number.isFinite(Date.parse(instant))) return '';
  const p = parts(formatter(zone), Date.parse(instant)); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function minuteInstant(instant) { return new Date(Math.floor(Date.parse(instant) / 60000) * 60000).toISOString(); }
export function resolveWallTime(value, zone) {
  if (!validZone(zone) || typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return { error: 'Enter a complete venue date and time.' };
  const [y, m, d, h, min] = value.match(/\d+/g).map(Number);
  if (y < 2000 || y > 2100 || h > 23 || min > 59) return { error: 'Use a valid date from 2000 through 2100.' };
  const wall = Date.UTC(y, m - 1, d, h, min), date = new Date(wall);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return { error: 'Enter a valid calendar date.' };
  const format = formatter(zone), candidates = [];
  // Exhaust all minute-aligned UTC instants within +/-24h. Do not guess one
  // offset or silently normalize a DST gap. 2881 bounded round-trip checks.
  for (let delta = -1440; delta <= 1440; delta++) {
    const ms = wall + delta * 60000, p = parts(format, ms);
    if (+p.year === y && +p.month === m && +p.day === d && +p.hour === h && +p.minute === min && +p.second === 0) candidates.push(new Date(ms).toISOString());
  }
  return candidates.length ? { candidates } : { error: 'This clock time cannot be used in this timezone. It may be skipped by daylight saving; choose another time.' };
}
export function priceInPaise(value) {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return minor <= 100000000 ? minor : null;
}
export const priceInput = minor => minor === null ? '' : `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
export const money = (minor, currency = 'INR') => minor === null ? 'Price not configured' : new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
export function showPayload({ localTime, occurrence, price }, venue, original, resolution) {
  const errors = {}, priceMinor = priceInPaise(price);
  if (priceMinor === null) errors.price = 'Enter a price from 0 to 10,00,000 rupees, with up to two decimal places.';
  const unchangedTime = original && localTime === wallMinute(original.startsAt, venue.timezone) && occurrence === minuteInstant(original.startsAt);
  const resolved = unchangedTime ? null : resolution ?? resolveWallTime(localTime, venue.timezone);
  let startsAt;
  if (!unchangedTime) {
    if (resolved.error) errors.localTime = resolved.error;
    else if (resolved.candidates.length === 1) startsAt = resolved.candidates[0];
    else if (resolved.candidates.includes(occurrence)) startsAt = occurrence;
    else errors.occurrence = 'This clock time occurs more than once. Choose the intended occurrence.';
  }
  if (Object.keys(errors).length) return { errors };
  if (!original) return { errors, body: { venueId: venue.id, expectedVenueRevision: venue.revision, startsAt, priceMinor, currency: 'INR' } };
  const changed = { ...(startsAt && Date.parse(startsAt) !== Date.parse(original.startsAt) ? { startsAt } : {}),
    ...(priceMinor !== original.priceMinor ? { priceMinor } : {}) };
  return { errors, unchanged: !Object.keys(changed).length, body: { expectedRevision: original.revision, ...changed } };
}
export function venueTime(instant, zone) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant));
}
