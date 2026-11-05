import { z } from 'zod';

// Explicit UTC instants only. A later UI must convert venue-local wall time
// deliberately, including DST ambiguity; Date's implicit parsing is not enough.
const startsAt = z.iso.datetime().refine(value => !value.startsWith('0000-') && /T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value));
const revision = z.number().int().min(0).max(2147483647);
const priceMinor = z.number().int().min(0).max(100000000);
export const showInput = z.object({
  venueId: z.uuid(), expectedVenueRevision: revision, startsAt,
  priceMinor, currency: z.literal('INR')
}).strict();
export const showPatch = z.object({
  expectedRevision: revision, startsAt: startsAt.optional(), priceMinor: priceMinor.optional()
}).strict().refine(value => value.startsAt !== undefined || value.priceMinor !== undefined);
export const showDelete = z.object({ expectedRevision: revision }).strict();
