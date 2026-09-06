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
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createStore, KEYS, StoreConflict } = require(path.join(ROOT, 'lib/store.js'));
const { loadEnv } = require(path.join(ROOT, 'lib/env.js'));
const { PHOTO_MIME, referencedPhotos } = require(path.join(ROOT, 'lib/photos.js'));

// The same .env rules as the server.
loadEnv(path.join(ROOT, '.env'));

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const PHOTO_DIR = path.join(ROOT, 'photos');

if (!process.env.S3_BUCKET) {
  console.error('S3_BUCKET is not set, so there is nowhere to upload to.');
  process.exit(1);
}
const store = createStore(process.env, ROOT, PHOTO_DIR);

const readLocal = async (rel) => {
  try {
    return JSON.parse(await fsp.readFile(path.join(ROOT, rel), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
};

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
  // The same reachability the app's orphan sweep runs on.
  const want = referencedPhotos(local.observations, local.species);
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
      await store.writePhoto(name, body, PHOTO_MIME[path.extname(name).toLowerCase()]);
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
