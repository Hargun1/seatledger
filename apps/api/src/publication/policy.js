import { z } from 'zod';
import { createHash } from 'node:crypto';

export const publishInput = z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
// The service supplies a deterministically ordered, locked snapshot. This is
// an optimistic comparison token, not a credential, signature or approval.
export const publicationToken = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
export const MAX_SHOWS = 20;
export const MAX_INVENTORY = 10000;
