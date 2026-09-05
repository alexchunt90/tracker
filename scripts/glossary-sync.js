#!/usr/bin/env node
/*
 * Move the glossary between the live store and the copy git tracks.
 *
 * The glossary is the one document that is both *edited in the app* and *worth
 * keeping in the repo*: the finds and the photographs are a log, but the
 * vocabulary is written prose — a definition worth reviewing in a diff and
 * worth having a history of. So data/glossary.json stays tracked, and this is
 * the way the two copies meet.
 *
 *   node scripts/glossary-sync.js diff     what differs, term by term
 *   node scripts/glossary-sync.js pull     live copy -> data/glossary.json
 *   node scripts/glossary-sync.js push     data/glossary.json -> live copy
 *
 * `pull` is the safe direction and the one you will use most: edit in the app,
 * pull, read the diff, commit. `push` is for edits made in the file — a batch
 * of definitions written in an editor — and refuses to run when the live copy
 * has moved on since the last pull, because a blind push would silently drop
 * whatever was typed into the app in between. Re-pull, reconcile, push again.
 *
 * Terms are written in sorted order. The app sorts on render, so the order in
 * the file means nothing to it — but it means everything to a diff, and an
 * unsorted file appends each newly-defined term at the bottom where it reads
 * as noise rather than as the one line that changed.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createStore, KEYS, StoreConflict, serialize } = require(path.join(ROOT, 'lib/store.js'));

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

const FILE = path.join(ROOT, KEYS.glossary);
const FORCE = process.argv.includes('--force');
const command = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'diff';

// STATE_DIR is honoured so this works against a container's volume too. With
// no bucket named it reads the same file it writes, which is a no-op rather
// than a mistake — say so instead of pretending to sync.
const STATE_DIR = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : ROOT;
const store = createStore(process.env, STATE_DIR, path.join(STATE_DIR, 'photos'));

const EMPTY = { version: 0, terms: {} };

/** The same document with its terms in sorted order, so diffs stay readable. */
const sorted = (glossary) => ({
  ...glossary,
  terms: Object.fromEntries(
    Object.keys(glossary.terms || {}).sort((a, b) => a.localeCompare(b))
      .map((k) => [k, glossary.terms[k]])
  ),
});

async function readFileCopy() {
  try {
    return JSON.parse(await fsp.readFile(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Term-by-term comparison. `a` is the file, `b` is the live copy. */
function compare(a, b) {
  const A = a.terms || {}, B = b.terms || {};
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort((x, y) => x.localeCompare(y));
  const onlyFile = [], onlyLive = [], changed = [];
  for (const k of keys) {
    if (!(k in B)) onlyFile.push(k);
    else if (!(k in A)) onlyLive.push(k);
    else if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) changed.push(k);
  }
  return { onlyFile, onlyLive, changed };
}

function report(file, live) {
  const { onlyFile, onlyLive, changed } = compare(file, live);
  console.log(`  file  data/glossary.json  v${file.version ?? '-'}  ${Object.keys(file.terms || {}).length} terms`);
  console.log(`  live  ${store.describe()}  v${live.version ?? '-'}  ${Object.keys(live.terms || {}).length} terms\n`);

  if (!onlyFile.length && !onlyLive.length && !changed.length) {
    console.log('  The two copies hold the same terms.');
    return false;
  }
  const list = (label, keys) => {
    if (!keys.length) return;
    console.log(`  ${label} (${keys.length}):`);
    for (const k of keys) console.log(`    ${k}`);
  };
  list('only in the file', onlyFile);
  list('only in the live copy', onlyLive);
  if (changed.length) {
    console.log(`  differing (${changed.length}):`);
    for (const k of changed) {
      console.log(`    ${k}`);
      console.log(`      file: ${JSON.stringify(file.terms[k])}`);
      console.log(`      live: ${JSON.stringify(live.terms[k])}`);
    }
  }
  return true;
}

(async () => {
  if (store.kind === 'file' && path.resolve(STATE_DIR) === ROOT) {
    console.error(
      'No bucket is configured and STATE_DIR is the checkout, so the live copy\n' +
      'and data/glossary.json are the same file. Nothing to sync.'
    );
    process.exit(1);
  }

  const live = (await store.read('glossary')).value ?? EMPTY;
  const file = (await readFileCopy()) ?? EMPTY;

  if (command === 'diff') {
    report(file, live);
    return;
  }

  if (command === 'pull') {
    if (!report(file, live)) return;
    await fsp.mkdir(path.dirname(FILE), { recursive: true });
    await fsp.writeFile(FILE, serialize(sorted(live)), 'utf8');
    console.log(`\n  Written to ${path.relative(ROOT, FILE)} at v${live.version}. Review it, then commit.`);
    return;
  }

  if (command === 'push') {
    // The version the file carries is the version it was pulled at. If the
    // live copy has moved past it, someone edited in the app since — pushing
    // would drop those edits without ever showing them.
    const held = Number(live.version) || 0;
    const base = Number(file.version) || 0;
    if (base !== held && !FORCE) {
      report(file, live);
      console.error(
        `\n  The live copy is at v${held}, the file was pulled at v${base}. Edits were\n` +
        '  made in the app since. Pull, reconcile them by hand, then push — or\n' +
        '  --force to overwrite the live copy with the file as it stands.'
      );
      process.exit(1);
    }
    if (!report(file, live)) return;

    // Bumped the way the server bumps it, so an open tab notices its copy is
    // stale rather than saving over this.
    const next = { ...sorted(file), version: held + 1 };
    try {
      await store.write('glossary', next, (await store.read('glossary')).token);
    } catch (err) {
      if (err instanceof StoreConflict) {
        console.error('\n  The live copy changed while pushing. Run diff again.');
        process.exit(1);
      }
      throw err;
    }
    // Keep the file's version in step, so the next push is not refused for a
    // gap this push itself created.
    await fsp.writeFile(FILE, serialize(next), 'utf8');
    console.log(`\n  Pushed to ${store.describe()} at v${next.version}.`);
    return;
  }

  console.error(`Unknown command "${command}". Use diff, pull or push.`);
  process.exit(1);
})().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
