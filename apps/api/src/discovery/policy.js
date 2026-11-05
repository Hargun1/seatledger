import { z } from 'zod';
import { HttpError } from '../http-error.js';

export const publicId = z.uuid();
export const publicPage = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  after: publicId.optional()
}).strict();
// UTC calendar days, not Date's permissive rollover of e.g. February 30.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00.000Z');
  return value >= '2000-01-01' && value <= '2100-12-31' &&
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const text = max => z.string().trim().min(1).max(max);
export const discoveryInput = publicPage.extend({
  q: text(120).optional(), city: text(120).optional(), category: text(60).optional(),
  from: day.optional(), to: day.optional()
}).refine(value => !value.from || !value.to || value.from <= value.to);
export const noQuery = z.object({}).strict();
export function parsePublic(schema, value, missing = false) {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(missing ? 404 : 400, missing ? 'NOT_FOUND' : 'INVALID_REQUEST');
  return result.data;
}
// Parameter binding prevents SQL injection; escaping separately makes LIKE
// wildcard characters ordinary search text. This is literal title substring search.
export const titlePattern = value => value == null ? null : `%${value.replace(/[\\%_]/g, '\\$&')}%`;
