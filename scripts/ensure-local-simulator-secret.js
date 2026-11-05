import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

const path = new URL('../.env',import.meta.url);
// Refuse to invent a database/auth setup. Existing settings remain in place.
const content = await readFile(path,'utf8'), parsed = parseEnv(content);
if (process.env.NODE_ENV === 'production' || parsed.NODE_ENV === 'production') throw new Error('Local simulator initialization is development-only.');
const matches = [...content.matchAll(/^[ \t]*SIMULATOR_WEBHOOK_SECRET[ \t]*=.*$/gm)];
if (matches.length > 1) throw new Error('Duplicate simulator secret entries; no value changed.');
if (parsed.SIMULATOR_WEBHOOK_SECRET) {
  if (parsed.SIMULATOR_WEBHOOK_SECRET.length !== 64 || !/^[a-f0-9]{64}$/.test(parsed.SIMULATOR_WEBHOOK_SECRET)
    || parsed.SIMULATOR_WEBHOOK_SECRET === parsed.AUTH_SECRET) throw new Error('Existing simulator secret is invalid; no value changed.');
  console.log('Existing local simulator signing secret preserved.');
} else {
  const line = 'SIMULATOR_WEBHOOK_SECRET=' + randomBytes(32).toString('hex');
  const updated = matches.length ? content.replace(/^[ \t]*SIMULATOR_WEBHOOK_SECRET[ \t]*=.*$/m,line)
    : content + (content.endsWith('\n') ? '' : '\n') + line + '\n';
  const temporary = new URL('../.env.simulator-'+randomBytes(8).toString('hex')+'.tmp',import.meta.url);
  try {
    await writeFile(temporary,updated,{flag:'wx',mode:0o600});
    if (await readFile(path,'utf8') !== content) throw new Error('Local settings changed during initialization; no replacement made.');
    await rename(temporary,path);
  } finally { await rm(temporary,{force:true}); }
  console.log('Local simulator signing secret initialized. Its value was not printed; restart the API.');
}
