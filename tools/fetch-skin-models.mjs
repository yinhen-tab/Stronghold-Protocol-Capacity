/**
 * Download the battle Spine models of the skins in data/assets.json.
 *
 * Why: chars[<charId>].skins[<skinId>].spine carries complete paths
 * (`/assets/spine/op/<charId>/<variant>/<front|back>/<file>.{skel,atlas,png}`) but nothing ever fetches
 * them — tools/fetch-assets.mjs only plans the operator's DEFAULT model (`spine/op/<charId>/front/`), so a
 * chosen skin changed the avatar and left the battle model on the default one.
 *
 * Source: fexli/ArknightsResource, same tree layout, capitalized side directory:
 *   spine/<charId>/<variant>/<Front|Back>/<file>
 *
 * Usage: node tools/fetch-skin-models.mjs [--dry-run] [--concurrency=10] [--only=<charId>]
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'data', 'assets.json');
const ASSETS = join(ROOT, 'public', 'assets');
const MIRROR = 'https://gh-proxy.com/';
const SRC = 'https://raw.githubusercontent.com/fexli/ArknightsResource/main/spine';

const argv = process.argv.slice(2);
const opts = {
  dryRun: argv.includes('--dry-run'),
  concurrency: 10,
  only: null,
};
for (const a of argv) {
  if (a.startsWith('--concurrency=')) opts.concurrency = Math.max(1, Number(a.slice(14)) || 10);
  if (a.startsWith('--only=')) opts.only = a.slice(7);
}

/** `/assets/spine/op/<char>/<variant>/<side>/<file>` -> the source URL, or null when it is not a skin model. */
function sourceUrl(path) {
  if (!path.startsWith('/assets/spine/')) return null;
  const rel = path.slice('/assets/spine/'.length); // op/<char>/<variant>/<side>/<file>
  const parts = rel.split('/');
  if (parts.length < 5 || parts[0] !== 'op') return null;
  const [, charId, variant, side, file] = parts;
  const Side = side === 'front' ? 'Front' : side === 'back' ? 'Back' : null;
  if (!Side) return null;
  return `${MIRROR}${SRC}/${charId}/${variant}/${Side}/${file}`;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  await writeFile(tmp, buf);
  await rename(tmp, dest);
  return { ok: true, bytes: buf.length };
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const wanted = new Map(); // absolute dest -> url
  let skins = 0;
  for (const [charId, rec] of Object.entries(manifest.chars || {})) {
    if (opts.only && charId !== opts.only) continue;
    const list = rec && rec.skins;
    if (!list) continue;
    for (const skin of Object.values(list)) {
      const spine = skin && skin.spine;
      if (!spine) continue;
      let touched = false;
      for (const side of ['front', 'back']) {
        const node = spine[side];
        if (!node) continue;
        const paths = [];
        if (node.skel) paths.push(node.skel);
        if (node.atlas) paths.push(node.atlas);
        for (const t of node.textures || []) paths.push(t);
        for (const p of paths) {
          const url = sourceUrl(p);
          if (!url) continue;
          const dest = join(ASSETS, p.slice('/assets/'.length));
          if (existsSync(dest)) continue;
          wanted.set(dest, url);
          touched = true;
        }
      }
      if (touched) skins += 1;
    }
  }

  console.log(`skins with missing models: ${skins}`);
  console.log(`files to download:        ${wanted.size}`);
  if (!wanted.size) { console.log('nothing to do'); return; }
  if (opts.dryRun) {
    for (const [dest, url] of [...wanted].slice(0, 5)) console.log(`  ${dest.replace(ROOT, '')}\n    ${url}`);
    console.log('dry run: nothing written');
    return;
  }

  let done = 0;
  let bytes = 0;
  let failed = 0;
  const queue = [...wanted.entries()];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const [dest, url] = item;
      try {
        const r = await download(url, dest);
        if (r.ok) { done += 1; bytes += r.bytes; }
        else { failed += 1; }
      } catch {
        failed += 1;
      }
      if ((done + failed) % 50 === 0) {
        console.log(`  ${done + failed}/${wanted.size} ok=${done} failed=${failed} ${(bytes / 1048576).toFixed(1)} MB`);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  console.log(`done: ${done} files, ${failed} failed, ${(bytes / 1048576).toFixed(1)} MB`);
}

main().catch((err) => { console.error(err); process.exit(1); });
