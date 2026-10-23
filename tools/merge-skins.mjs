/**
 * Merge the picture-only skin catalogue (chars[<charId>].skins) and its avatar
 * files from another checkout into this one.
 *
 * The skin code (public/js/ui/skins.js, ui/skinPicker.js) reads
 * `chars[<charId>].skins[<skinId>] = { name, group, avatar, ... }` from
 * data/assets.json — a field that tools/fetch-assets.mjs does not produce, so a
 * fresh asset fetch leaves the skin picker empty. Re-run this after a fetch.
 *
 * Usage: node tools/merge-skins.mjs [--from=<checkout>] [--dry-run]
 *   --from      the checkout that has the skins (default ../Stronghold-Protocol-PY-0.3.0align)
 *   --dry-run   report what would change, write nothing
 */
import { readFile, writeFile, mkdir, copyFile, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'data', 'assets.json');
const ASSETS = join(ROOT, 'public', 'assets');

const argv = process.argv.slice(2);
const opts = {
  from: join(ROOT, '..', 'Stronghold-Protocol-PY-0.3.0align'),
  dryRun: argv.includes('--dry-run'),
};
for (const a of argv) {
  if (a.startsWith('--from=')) opts.from = resolve(a.slice('--from='.length));
}

/** sha1 of the manifest body (everything but version/hash/generator/stats), 12 hex chars. */
function contentHash(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

async function main() {
  const srcManifest = join(opts.from, 'data', 'assets.json');
  const srcAvatars = join(opts.from, 'public', 'assets', 'char', 'skin_avatar');
  if (!existsSync(srcManifest)) {
    console.error(`no skin source at ${srcManifest}\npass --from=<checkout that has the skins>`);
    process.exit(2);
  }

  const cur = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const src = JSON.parse(await readFile(srcManifest, 'utf8'));
  const { version, hash: oldHash, generator, stats, ...body } = cur;

  let charsMerged = 0;
  let skinsAdded = 0;
  let skinsKept = 0;
  let skinsNoArt = 0;
  const wanted = new Map(); // rel path under public/assets -> source file

  /** The avatar URL of a skin as a path under public/assets, or null. */
  const artRel = (skin) => {
    for (const key of ['avatar', 'avatarE2', 'portrait', 'portraitE2', 'illust']) {
      const url = skin[key];
      if (typeof url === 'string' && url.startsWith('/assets/')) return url.slice('/assets/'.length);
    }
    return null;
  };

  for (const [charId, rec] of Object.entries(src.chars || {})) {
    const skins = rec && rec.skins;
    if (!skins || typeof skins !== 'object') continue;
    const mine = body.chars?.[charId];
    if (!mine) continue; // operator not in this checkout: nothing to attach it to
    mine.skins = mine.skins && typeof mine.skins === 'object' ? mine.skins : {};
    let touched = false;
    for (const [skinId, skin] of Object.entries(skins)) {
      if (!skin || typeof skin !== 'object') continue;
      if (mine.skins[skinId]) { skinsKept += 1; continue; }
      // The source manifest lists more skins than it ships art for (skins-installed.json is the
      // subset with pictures). A skin whose art is nowhere would show a broken image in the
      // picker, so only the ones we can actually draw are merged.
      const rel = artRel(skin);
      const from = rel ? join(srcAvatars, rel.split('/').pop()) : null;
      const have = rel ? existsSync(join(ASSETS, rel)) || (!!from && existsSync(from)) : false;
      if (!have) { skinsNoArt += 1; continue; }
      mine.skins[skinId] = skin;
      skinsAdded += 1;
      touched = true;
      if (rel && !existsSync(join(ASSETS, rel))) wanted.set(rel, from);
    }
    if (touched) charsMerged += 1;
  }

  // Copy the avatar files the manifest now points at but the disk does not have.
  let copied = 0;
  let copyMissing = 0;
  for (const [rel, from] of wanted) {
    if (!existsSync(from)) { copyMissing += 1; console.warn(`  source missing: ${rel}`); continue; }
    if (opts.dryRun) { copied += 1; continue; }
    const to = join(ASSETS, rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    copied += 1;
  }

  // Bytes/files in stats describe the disk, so account for what we just added.
  let addedBytes = 0;
  for (const rel of wanted.keys()) {
    const to = join(ASSETS, rel);
    try { addedBytes += (await stat(to)).size; } catch { /* counted as missing */ }
  }
  const nextStats = { ...stats };
  if (typeof nextStats.files === 'number') nextStats.files += copied;
  if (typeof nextStats.bytes === 'number') nextStats.bytes += addedBytes;

  const next = { version, hash: contentHash(body), generator, stats: nextStats, ...body };
  const text = JSON.stringify(next);
  const changed = text !== JSON.stringify(cur);

  console.log(`source      ${opts.from}`);
  console.log(`operators   ${charsMerged} gained skins, ${skinsAdded} skins added, ${skinsKept} already present`);
  if (skinsNoArt) console.log(`            ${skinsNoArt} listed skins have no art in the source and were skipped`);
  console.log(`avatars     ${copied} copied (${(addedBytes / 1048576).toFixed(1)} MB)` + (copyMissing ? `, ${copyMissing} missing at source` : ''));
  console.log(`manifest    ${changed ? `hash ${oldHash} -> ${next.hash}` : 'unchanged'}`);

  if (opts.dryRun) { console.log('dry run: nothing written'); return; }
  if (!changed && !copied) { console.log('nothing to do'); return; }

  const tmp = MANIFEST + '.tmp';
  await writeFile(tmp, text);
  await rename(tmp, MANIFEST);
  console.log(`wrote       ${MANIFEST}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
