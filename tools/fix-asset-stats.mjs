// One-off: recompute stats.files / stats.bytes from the disk (assets + fonts) and write
// data/assets.json back with the same compact JSON.stringify the generator uses, so the
// manifest hash stays valid for the body it describes.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'data', 'assets.json');

function tally(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { files += 1; bytes += statSync(p).size; }
    }
  };
  try { walk(dir); } catch { /* absent */ }
  return { files, bytes };
}

const assets = tally(join(ROOT, 'public', 'assets'));
const fonts = tally(join(ROOT, 'public', 'fonts'));
const cur = JSON.parse(await readFile(MANIFEST, 'utf8'));
const before = { ...cur.stats };
cur.stats.files = assets.files + fonts.files;
cur.stats.bytes = assets.bytes + fonts.bytes;
const text = JSON.stringify(cur);
const tmp = MANIFEST + '.tmp';
await writeFile(tmp, text);
await rename(tmp, MANIFEST);
console.log('stats.files', before.files, '->', cur.stats.files);
console.log('stats.bytes', before.bytes, '->', cur.stats.bytes);
console.log('hash (unchanged, stats is not part of it):', cur.hash);
