import { z } from 'zod';
import { HttpError } from '../http-error.js';

export const uuid = z.uuid().transform(value => value.toLowerCase());
export const plainUuid = z.uuid();
const nullableText = max => z.string().trim().min(1).max(max).nullable();
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00Z');
  return value >= '2000-01-01' && value <= '2100-12-31' && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export const preferencesSchema = z.object({
  category: nullableText(60), city: nullableText(120),
  when: z.enum(['any','today','tomorrow','this_weekend','next_weekend','dates']).nullable(),
  fromDay: day.nullable(), toDay: day.nullable(),
  ticketCount: z.number().int().min(1).max(8).nullable(),
  budgetMinor: z.number().int().min(0).max(100000000).nullable(),
  budgetScope: z.enum(['total','per_ticket','none']).nullable(),
  adjacent: z.boolean().nullable(), preference: z.enum(['cheapest','center','any']).nullable()
}).strict();
export const offerSchema = z.object({ offerRef: plainUuid }).strict();
export const seatsSchema = z.object({ offerRef: plainUuid, ticketCount: z.number().int().min(1).max(8).nullable(),
  adjacent: z.boolean().nullable(), preference: z.enum(['cheapest','center','any']).nullable() }).strict();
export const proposalSchema = z.object({ optionRef: plainUuid }).strict();
export const statusSchema = z.object({ reservationId: plainUuid.nullable() }).strict();
export const clarificationSchema = z.object({ field: z.enum(['category','city','dates','ticketCount','budget','seating']) }).strict();
export const messageSchema = z.object({ message: z.string().trim().min(1).max(1500), revision: z.number().int().min(0).max(100) }).strict();
export const confirmationSchema = z.object({ proposalId: uuid, revision: z.number().int().min(0).max(100), confirmed: z.literal(true) }).strict();
export const empty = z.object({}).strict();
export function parse(schema, value, missing = false) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(missing ? 404 : 400, missing ? 'NOT_FOUND' : 'INVALID_REQUEST');
  return parsed.data;
}
