#!/usr/bin/env node
/*
 * Push the local state into the bucket, once.
 *
 * This is the one-way trip that makes the bucket the source of truth: the four
 * documents, then every photograph a record points at. It is deliberately not
 * part of the server — seeding a bucket from a laptop is something you do
 * knowingly, and something you should be able to re-read before doing.
 *
 *   node scripts/upload-to-s3.js --dry-run     say what would go, send nothing
 *   node scripts/upload-to-s3.js               send it
 *   node scripts/upload-to-s3.js --force       overwrite documents already there
 *
 * Photographs are skipped when the bucket already holds them, so an
 * interrupted run resumes by being run again.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createStore, KEYS, StoreConflict } = require(path.join(ROOT, 'lib/store.js'));

// --- .env, same rules as the server -----------------------------------------
for (const line of (fs.existsSync(path.join(ROOT, '.env'))
  ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  if (!key || key in process.env) continue;
  let value = trimmed.slice(eq + 1).trim();
  const q = value[0];
  if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1) value = value.slice(1, -1);
  process.env[key] = value;
}

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const PHOTO_DIR = path.join(ROOT, 'photos');

if (!process.env.S3_BUCKET) {
  console.error('S3_BUCKET is not set, so there is nowhere to upload to.');
  process.exit(1);
}
const store = createStore(process.env, ROOT, PHOTO_DIR);

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic',
  '.heif': 'image/heif', '.avif': 'image/avif', '.tiff': 'image/tiff' };

const readLocal = async (rel) => {
  try {
    return JSON.parse(await fsp.readFile(path.join(ROOT, rel), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
};

/** Every photograph any record points at — the same reachability the app uses. */
function referenced(observations, species) {
  const set = new Set();
  for (const rec of [...(observations || []), ...(species || [])]) {
    for (const p of rec.photos || []) {
      if (p?.file) set.add(p.file);
      if (p?.thumb) set.add(p.thumb);
    }
  }
  return set;
}

(async () => {
  console.log(`${DRY ? 'Would upload' : 'Uploading'} to ${store.describe()}\n`);

  // --- the documents --------------------------------------------------------
  const local = {};
  for (const [key, rel] of Object.entries(KEYS)) {
    local[key] = await readLocal(rel);
    if (local[key] === undefined) { console.log(`  ${rel.padEnd(24)} absent locally, skipping`); continue; }
    const count = Array.isArray(local[key]) ? `${local[key].length} records`
      : `${Object.keys(local[key].terms || local[key]).length} keys`;
    if (DRY) { console.log(`  ${rel.padEnd(24)} ${count}`); continue; }

    const { token } = await store.read(key);
    if (token && !FORCE) {
      console.log(`  ${rel.padEnd(24)} already in the bucket — leaving it (--force to replace)`);
      continue;
    }
    try {
      await store.write(key, local[key], token);
      console.log(`  ${rel.padEnd(24)} ${count} uploaded`);
    } catch (err) {
      if (err instanceof StoreConflict) {
        console.log(`  ${rel.padEnd(24)} changed while uploading — run again`);
      } else throw err;
    }
  }

  // --- the photographs ------------------------------------------------------
  const want = referenced(local.observations, local.species);
  const onDisk = await fsp.readdir(PHOTO_DIR).catch(() => []);
  const present = new Set(onDisk);
  const missing = [...want].filter((f) => !present.has(f));
  const orphans = onDisk.filter((f) => !want.has(f) && !f.endsWith('.tmp'));

  let bytes = 0;
  for (const f of want) if (present.has(f)) bytes += (await fsp.stat(path.join(PHOTO_DIR, f))).size;
  console.log(`\n  ${want.size} photographs referenced, ${bytes / 1048576 | 0} MB on disk`);
  if (missing.length) console.log(`  ${missing.length} referenced but not on disk — nothing to send for those`);
  if (orphans.length) console.log(`  ${orphans.length} on disk that no record points at — not uploaded`);

  if (DRY) { console.log('\nDry run. Nothing sent.'); return; }

  // Already-there photographs are skipped, so an interrupted run resumes.
  const already = new Set((await store.listPhotos()).map((p) => p.name));
  const todo = [...want].filter((f) => present.has(f) && !already.has(f));
  console.log(`  ${already.size} already in the bucket, ${todo.length} to send\n`);

  let done = 0, failed = 0;
  for (const name of todo) {
    try {
      const body = await fsp.readFile(path.join(PHOTO_DIR, name));
      await store.writePhoto(name, body, MIME[path.extname(name).toLowerCase()]);
      done++;
    } catch (err) {
      failed++;
      console.error(`  !! ${name}: ${err.message}`);
      if (failed > 5) { console.error('  too many failures, stopping'); break; }
    }
    if (done % 100 === 0) console.log(`  ${done}/${todo.length}`);
  }
  console.log(`\n${done} photographs uploaded${failed ? `, ${failed} failed` : ''}.`);
})().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
