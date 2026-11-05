import { z } from 'zod';

const email=z.string().trim().toLowerCase().max(254).pipe(z.email());
const password=z.string().refine(value=>[...value].length>=1 && [...value].length<=128 && new TextEncoder().encode(value).byteLength<=256);
export const loginInput=z.object({email,password}).strict();
export const registerInput=z.object({
  email,
  password:password.refine(value=>[...value].length>=15),
  displayName:z.string().trim().min(1).max(120)
}).strict();
