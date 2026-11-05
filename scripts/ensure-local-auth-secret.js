import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

const path = new URL('../.env', import.meta.url);
let content;
try { content = await readFile(path,'utf8'); }
catch (error) { if(error.code!=='ENOENT') throw error; content=await readFile(new URL('../.env.example',import.meta.url),'utf8'); }
const parsed=parseEnv(content);
if(process.env.NODE_ENV==='production' || parsed.NODE_ENV==='production') throw new Error('Local secret initialization is development-only.');
const matches=[...content.matchAll(/^[ \t]*AUTH_SECRET[ \t]*=(.*)$/gm)];
if(matches.length>1) throw new Error('Duplicate AUTH_SECRET entries; resolve them before continuing.');
const existing=parsed.AUTH_SECRET;
if(existing) {
  if(!/^[a-f0-9]{64}$/.test(existing)) throw new Error('Existing AUTH_SECRET must be 64 lowercase hexadecimal characters; it was not overwritten.');
  console.log('Existing local authentication secret preserved.');
} else {
  const line=`AUTH_SECRET=${randomBytes(32).toString('hex')}`;
  content=matches.length ? content.replace(/^[ \t]*AUTH_SECRET[ \t]*=.*$/m,line) : `${content.trimEnd()}\n${line}\n`;
  await writeFile(path,content,{mode:0o600});
  console.log('Local authentication secret initialized. Its value was not printed.');
}
