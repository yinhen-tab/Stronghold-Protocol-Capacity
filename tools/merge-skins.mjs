/**
 * Merge the picture-only skin catalogue (chars[<charId>].skins) and its avatar files into
 * data/assets.json / public/assets.
 *
 * Why: the skin code (public/js/ui/skins.js, ui/skinPicker.js) reads
 * `chars[<charId>].skins[<skinId>] = { name, group, avatar, ... }` from data/assets.json, and that
 * file is *generated* by tools/fetch-assets.mjs — which does not produce the field. A fresh asset
 * fetch therefore empties the skin picker. Re-run this afterwards.
 *
 * Sources, in order:
 *   1. this checkout: data/skins-catalog.json (the catalogue) + data/skins-art/*.png (the art)
 *   2. another checkout: `--from=<path>` reads its data/assets.json and
 *      public/assets/char/skin_avatar/
 *
 * Usage: node tools/merge-skins.mjs [--from=<checkout>] [--dry-run] [--all]
 *   --from   take the catalogue and art from another checkout instead
 *   --dry-run   report what would change, write nothing
 *   --all       also merge skins whose art is nowhere on disk (they render as a broken image)
 */
import { readFile, writeFile, mkdir, copyFile, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'data', 'assets.json');
const CATALOG = join(ROOT, 'data', 'skins-catalog.json');
const ART = join(ROOT, 'data', 'skins-art');
const ASSETS = join(ROOT, 'public', 'assets');

const argv = process.argv.slice(2);
const opts = {
  from: null,
  dryRun: argv.includes('--dry-run'),
  all: argv.includes('--all'),
};
for (const a of argv) {
  if (a.startsWith('--from=')) opts.from = resolve(a.slice('--from='.length));
}

/** sha1 of the manifest body (everything but version/hash/generator/stats), 12 hex chars. */
function contentHash(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

/** The catalogue as { [charId]: { [skinId]: skin } }, from this checkout or another one. */
async function loadCatalogue() {
  if (!opts.from) {
    if (!existsSync(CATALOG)) {
      console.error(`no catalogue at ${CATALOG}\nrun with --from=<checkout that has the skins> to rebuild it`);
      process.exit(2);
    }
    const cat = JSON.parse(await readFile(CATALOG, 'utf8'));
    return { chars: cat.chars || {}, artDir: null };
  }
  const srcManifest = join(opts.from, 'data', 'assets.json');
  if (!existsSync(srcManifest)) {
    console.error(`no skin source at ${srcManifest}`);
    process.exit(2);
  }
  const src = JSON.parse(await readFile(srcManifest, 'utf8'));
  const chars = {};
  for (const [charId, rec] of Object.entries(src.chars || {})) {
    if (rec && rec.skins && typeof rec.skins === 'object') chars[charId] = rec.skins;
  }
  return { chars, artDir: join(opts.from, 'public', 'assets', 'char', 'skin_avatar') };
}

/** Where the art of a skin lives on this disk, or null. */
function artSource(skin, artDir) {
  for (const key of ['avatar', 'avatarE2', 'portrait', 'portraitE2', 'illust']) {
    const url = skin[key];
    if (typeof url !== 'string' || !url.startsWith('/assets/')) continue;
    const rel = url.slice('/assets/'.length);
    if (existsSync(join(ASSETS, rel))) return { rel, from: null }; // already in place
    const name = basename(rel);
    if (existsSync(join(ART, name))) return { rel, from: join(ART, name) };
    if (artDir && existsSync(join(artDir, name))) return { rel, from: join(artDir, name) };
    return { rel, from: null, missing: true };
  }
  return null;
}

/**
 * The 1:2 portrait of a skin. `data/skin-portraits/<id>.webp` (19 MB, committed) wins over whatever
 * tools/fetch-skin-portraits.py left in public/assets, so a fresh clone gets portraits from git alone —
 * no Python on the build host. Returns the URL to record plus the file to copy, or null.
 */
function portraitFor(skinId) {
  const base = skinId.replace(/[@#]/g, '_');
  const name = base + '.webp';
  const rel = `char/skin_portrait/${name}`;
  const shipped = join(ROOT, 'data', 'skin-portraits', name);
  if (existsSync(shipped)) {
    // always copy: the committed WebP is the source of truth, an older run may have left a
    // different size in public/assets
    return { url: `/assets/${rel}`, rel, from: shipped };
  }
  for (const ext of ['.webp', '.png']) {
    const r = `char/skin_portrait/${base}${ext}`;
    if (existsSync(join(ASSETS, r))) return { url: `/assets/${r}`, rel: r, from: null };
  }
  return null;
}

async function main() {
  const { chars, artDir } = await loadCatalogue();
  const cur = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const { version, hash: oldHash, generator, stats, ...body } = cur;

  let charsMerged = 0;
  let skinsAdded = 0;
  let skinsKept = 0;
  let skinsNoArt = 0;
  let skinsPictured = 0;
  const wanted = new Map(); // rel under public/assets -> file to copy

  for (const [charId, skins] of Object.entries(chars)) {
    const mine = body.chars?.[charId];
    if (!mine) continue; // operator not in this checkout: nothing to attach it to
    mine.skins = mine.skins && typeof mine.skins === 'object' ? mine.skins : {};
    let touched = false;
    for (const [skinId, skin] of Object.entries(skins)) {
      if (!skin || typeof skin !== 'object') continue;
      if (mine.skins[skinId]) {
        skinsKept += 1;
        // the entry is there but its art may have been pruned with public/assets: put it back
        const art = artSource(skin, artDir);
        if (art && art.from) wanted.set(art.rel, art.from);
        const pic = portraitFor(skinId);
        if (pic) {
          if (pic.from) wanted.set(pic.rel, pic.from);
          if (mine.skins[skinId].portrait !== pic.url) {
            mine.skins[skinId] = { ...mine.skins[skinId], portrait: pic.url };
            skinsPictured += 1;
          }
        }
        continue;
      }
      const art = artSource(skin, artDir);
      if (art && art.missing && !opts.all) { skinsNoArt += 1; continue; }
      const pic = portraitFor(skinId);
      if (pic && pic.from) wanted.set(pic.rel, pic.from);
      mine.skins[skinId] = pic ? { ...skin, portrait: pic.url } : skin;
      if (pic) skinsPictured += 1;
      skinsAdded += 1;
      touched = true;
      if (art && art.from) wanted.set(art.rel, art.from);
    }
    if (touched) charsMerged += 1;
  }

  let copied = 0;
  let addedBytes = 0;
  for (const [rel, from] of wanted) {
    if (opts.dryRun) { copied += 1; continue; }
    const to = join(ASSETS, rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    copied += 1;
  }
  for (const rel of wanted.keys()) {
    try { addedBytes += (await stat(join(ASSETS, rel))).size; } catch { /* missing */ }
  }

  const nextStats = { ...stats };
  // Only a *new* skin entry adds files to the manifest's totals; re-copying art that the
  // manifest already counted (a pruned public/assets) must not inflate them.
  if (skinsAdded > 0) {
    if (typeof nextStats.files === 'number') nextStats.files += copied;
    if (typeof nextStats.bytes === 'number') nextStats.bytes += addedBytes;
  }

  const next = { version, hash: contentHash(body), generator, stats: nextStats, ...body };
  const text = JSON.stringify(next);
  const changed = text !== JSON.stringify(cur);

  console.log(`source      ${artDir || CATALOG}`);
  console.log(`operators   ${charsMerged} gained skins, ${skinsAdded} added, ${skinsKept} already present`);
  if (skinsNoArt) console.log(`            ${skinsNoArt} have no art on disk and were skipped (--all to keep them)`);
  if (skinsPictured) console.log(`portraits   ${skinsPictured} skins carry a 1:2 portrait`);
  console.log(`art         ${copied} copied` + (addedBytes ? ` (${(addedBytes / 1048576).toFixed(1)} MB)` : ''));
  console.log(`manifest    ${changed ? `hash ${oldHash} -> ${next.hash}` : 'unchanged'}`);

  if (opts.dryRun) { console.log('dry run: nothing written'); return; }
  if (!changed && !copied) { console.log('nothing to do'); return; }
  const tmp = MANIFEST + '.tmp';
  await writeFile(tmp, text);
  await rename(tmp, MANIFEST);
  console.log(`wrote       ${MANIFEST}`);

  // Keep the in-repo catalogue in step with what the manifest now holds, so the next
  // `fetch-assets` run can be repaired with this script alone (art + portraits included).
  const rebuilt = {};
  for (const [cid, rec] of Object.entries(body.chars || {})) {
    if (rec && rec.skins && Object.keys(rec.skins).length) rebuilt[cid] = rec.skins;
  }
  const prevCat = existsSync(CATALOG) ? JSON.parse(await readFile(CATALOG, 'utf8')) : {};
  const catText = JSON.stringify({
    about: prevCat.about
      || 'Picture-only skins shipped with this checkout: entries of data/assets.json chars[*].skins that have art '
       + 'in data/skins-art/. tools/merge-skins.mjs merges them back into data/assets.json after a fetch-assets run.',
    count: Object.values(rebuilt).reduce((n, r) => n + Object.keys(r).length, 0),
    chars: rebuilt,
  });
  if (catText !== JSON.stringify(prevCat)) {
    const ctmp = CATALOG + '.tmp';
    await writeFile(ctmp, catText);
    await rename(ctmp, CATALOG);
    console.log(`wrote       ${CATALOG}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
