import { mkdir, readFile, writeFile, lstat, realpath, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Optional local installation repair when Windows refuses npm's workspace
// junction. No dependency downloads, elevated permissions or app source edits.
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'packages/shared');
const destination = path.join(root, 'node_modules/@seatledger/shared');
const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
if (metadata.name !== '@seatledger/shared' || metadata.exports !== './src/index.js') throw new Error('Unsupported shared package layout');
const info = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
if (info?.isSymbolicLink()) {
  if (await realpath(destination) !== await realpath(source)) throw new Error('Existing workspace link points elsewhere; refusing to alter it');
} else {
  const entry = path.join(destination, 'src/index.js');
  const relative = path.relative(path.dirname(entry), path.join(source, 'src/index.js')).split(path.sep).join('/');
  const forwarder = `// Local workspace forwarder; canonical source stays in packages/shared.\nexport * from ${JSON.stringify(relative)};\n`;
  if (await readFile(entry, 'utf8').catch(() => null) !== forwarder) {
    const backup = path.join(root, 'test-results/shared-import-repair', String(Date.now()));
    for (const name of ['package.json', 'src/index.js']) {
      const existing = path.join(destination, name);
      if (await lstat(existing).catch(() => null)) {
        await mkdir(path.dirname(path.join(backup, name)), { recursive: true });
        await copyFile(existing, path.join(backup, name));
      }
    }
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(path.join(destination, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
    await writeFile(entry, forwarder);
  }
}
const installed = await import('@seatledger/shared');
const canonical = await import(pathToFileURL(path.join(source, 'src/index.js')));
if (installed.reservationInput !== canonical.reservationInput) throw new Error('Shared import still differs from canonical source');
console.log('Shared workspace import resolves to the canonical live schema. No symlink or .env change.');
