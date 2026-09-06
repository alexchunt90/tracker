/*
 * The HTTP surface, end to end.
 *
 * The server is started as a child process against an empty state directory,
 * so it seeds itself from example/ and every test runs against the made-up
 * wood rather than anybody's log. S3 is switched off explicitly: a .env in the
 * checkout may name a real bucket, and a test that wrote to it would be a
 * test that edited the user's data.
 *
 * Nothing here reaches an outside service. The upstream routes are exercised
 * only as far as their input validation, which answers before any fetch.
 *
 *   node --test test/server.test.js
 */
const assert = require('node:assert');
const { test, before, after } = require('node:test');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

let child = null;
let base = '';
let stateDir = '';

/** A port nothing is listening on right now. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-test-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      STATE_DIR: stateDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      // Present-but-empty, so the server's .env loader leaves them alone and
      // the store falls through to the filesystem.
      S3_BUCKET: '', S3_PREFIX: '', S3_ENDPOINT: '',
      AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let banner = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${banner}`)), 10000);
    child.stdout.on('data', (chunk) => {
      banner += chunk;
      if (banner.includes('Field Notes')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (chunk) => { banner += chunk; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${banner}`)); });
  });
});

after(async () => {
  if (child) child.kill();
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
});

/** A request, with the JSON body parsed when there is one. */
async function call(method, route, body, headers = {}) {
  const res = await fetch(base + route, {
    method,
    headers: body !== undefined && !(body instanceof Uint8Array)
      ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, payload };
}

// --- boot -------------------------------------------------------------------

test('an empty state directory is seeded from example/', async () => {
  const { status, payload } = await call('GET', '/api/state');
  assert.equal(status, 200);
  assert.ok(payload.config?.app?.title);
  assert.ok(Array.isArray(payload.observations) && payload.observations.length > 0);
  assert.ok(Array.isArray(payload.species) && payload.species.length > 0);
  assert.ok(payload.glossary?.terms);

  // The example dates are shifted so the newest is a few days old, keeping
  // the gaps between them.
  const stamps = payload.observations.map((o) => Date.parse(o.observedAt)).filter(Number.isFinite);
  const newest = Math.max(...stamps);
  const age = (Date.now() - newest) / 86400000;
  assert.ok(age > 4 && age < 6, `newest example find is ${age.toFixed(1)} days old`);

  // Written to the state directory, not the checkout.
  const seeded = JSON.parse(await fsp.readFile(path.join(stateDir, 'config.json'), 'utf8'));
  assert.equal(seeded.app.title, payload.config.app.title);
});

test('the page and its assets are served; nothing outside public/ is', async () => {
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.payload.toString(), /<title>Field Notes<\/title>/);

  const js = await call('GET', '/model.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  assert.equal((await call('GET', '/nope.js')).status, 404);
  assert.equal((await call('GET', '/../server.js')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/server.js')).status, 404);
  assert.equal((await call('POST', '/index.html')).status, 405);
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});

test('text goes out gzipped when asked for, and only then; images never do', async () => {
  // Undici undoes the gzip itself, so the body reads the same either way and
  // the header is what says whether the wire carried the smaller form.
  const zipped = await call('GET', '/api/state', undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers.get('content-encoding'), 'gzip');
  assert.equal(zipped.headers.get('vary'), 'Accept-Encoding');
  assert.ok(Array.isArray(zipped.payload.species) && zipped.payload.species.length > 0);

  const plain = await call('GET', '/api/state', undefined, { 'Accept-Encoding': 'identity' });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.deepEqual(plain.payload, zipped.payload);

  const js = await call('GET', '/app.js', undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(js.headers.get('content-encoding'), 'gzip');

  // A 404 body is a few dozen bytes: the gzip header would cost more than it saves.
  const tiny = await call('GET', '/api/nothing', undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(tiny.status, 404);
  assert.equal(tiny.headers.get('content-encoding'), null);

  const icon = await call('GET', '/icon-192.png', undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-encoding'), null);
  assert.equal(icon.headers.get('vary'), null);
});

test('an asset the browser already holds is answered with a 304, not the bytes', async () => {
  const first = await call('GET', '/app.js');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const tag = first.headers.get('etag');
  assert.match(tag, /^W\/"[A-Za-z0-9_-]+"$/);

  // Same tag whether or not the wire was compressed: it names the bytes, not
  // the encoding, which is what lets one validator serve both.
  const zipped = await call('GET', '/app.js', undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(zipped.headers.get('etag'), tag);

  const again = await call('GET', '/app.js', undefined, { 'If-None-Match': tag, 'Accept-Encoding': 'gzip' });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('etag'), tag);
  assert.equal(again.payload.length, 0);

  const stale = await call('GET', '/app.js', undefined, { 'If-None-Match': 'W/"somethingelse"' });
  assert.equal(stale.status, 200);
  assert.ok(stale.payload.length > 0);

  // A different file, a different tag; JSON carries none and is never cached.
  const css = await call('GET', '/styles.css');
  assert.notEqual(css.headers.get('etag'), tag);
  const state = await call('GET', '/api/state');
  assert.equal(state.headers.get('etag'), null);
  assert.equal(state.headers.get('cache-control'), 'no-store');

  // HEAD carries the validator too, and nothing else.
  const head = await fetch(base + '/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), tag);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

// --- collections ------------------------------------------------------------

test('a find is created, versioned, and refused when stale', async () => {
  const id = 'test-find-1';
  const record = { id, version: 0, type: 'fungi', speciesId: null, confidence: 'high',
    characters: {}, observedAt: '2025-10-01T09:00', lat: 47.5, lon: -123.1, photos: [] };

  const created = await call('PUT', `/api/observations/${id}`, record);
  assert.equal(created.status, 200);
  assert.equal(created.payload.version, 1);
  assert.equal(created.payload.record.id, id);

  // Echoing the version it was given wins; echoing the old one does not.
  const again = await call('PUT', `/api/observations/${id}`, { ...record, version: 1, place: 'ridge' });
  assert.equal(again.status, 200);
  assert.equal(again.payload.version, 2);

  const stale = await call('PUT', `/api/observations/${id}`, { ...record, version: 1, place: 'valley' });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.version, 2);
  assert.equal(stale.payload.record.place, 'ridge');

  // The body has to be about the record the URL names.
  const mismatch = await call('PUT', `/api/observations/${id}`, { ...record, id: 'other', version: 2 });
  assert.equal(mismatch.status, 400);

  const state = await call('GET', '/api/state');
  const stored = state.payload.observations.find((o) => o.id === id);
  assert.equal(stored.place, 'ridge');
  assert.equal(stored.version, 2);

  assert.equal((await call('DELETE', `/api/observations/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/observations/${id}`)).status, 404);
});

test('a batch of finds lands in one write, or not at all', async () => {
  const mk = (id, over = {}) => ({ id, version: 0, type: 'fungi', speciesId: null, confidence: 'high',
    characters: {}, observedAt: '2025-10-02T09:00', lat: null, lon: null, photos: [], ...over });

  const saved = await call('POST', '/api/observations', { observations: [mk('test-batch-1'), mk('test-batch-2', { place: 'ridge' })] });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.saved, 2);
  assert.deepEqual(saved.payload.records.map((r) => r.version), [1, 1]);
  assert.equal(saved.payload.records[1].place, 'ridge');

  const state = await call('GET', '/api/state');
  const ids = state.payload.observations.map((o) => o.id);
  assert.ok(ids.includes('test-batch-1') && ids.includes('test-batch-2'));
  const before = state.payload.observations.length;

  // A bad record anywhere refuses the whole batch, and says which one.
  const shapes = [
    [{ observations: 'nope' }, 400],
    [{ observations: [] }, 400],
    [{ observations: [mk('test-batch-3'), 'nope'] }, 400],
    [{ observations: [mk('test-batch-3'), mk('bad id!')] }, 400],
    [{ observations: [mk('test-batch-3'), mk('test-batch-3')] }, 400],
    // An id already in the log is a conflict, not an update.
    [{ observations: [mk('test-batch-3'), mk('test-batch-1')] }, 409],
  ];
  for (const [body, status] of shapes) {
    const res = await call('POST', '/api/observations', body);
    assert.equal(res.status, status, `${JSON.stringify(body).slice(0, 60)} → ${res.status}`);
  }
  const after_ = await call('GET', '/api/state');
  assert.equal(after_.payload.observations.length, before);
  assert.ok(!after_.payload.observations.some((o) => o.id === 'test-batch-3'));

  // Once landed they are ordinary records: versioned, editable, deletable.
  const edit = await call('PUT', '/api/observations/test-batch-1', { ...mk('test-batch-1'), version: 1, place: 'valley' });
  assert.equal(edit.status, 200);
  assert.equal(edit.payload.version, 2);
  for (const id of ['test-batch-1', 'test-batch-2']) {
    assert.equal((await call('DELETE', `/api/observations/${id}`)).status, 200);
  }
});

test('species are kept sorted by common name, and deleting one counts its orphans', async () => {
  const mk = (id, commonName) => call('PUT', `/api/species/${id}`,
    { id, version: 0, kind: 'fungi', commonName, scientificName: '', photos: [], characters: {} });
  assert.equal((await mk('test-sp-z', 'Zebra Bolete')).status, 200);
  assert.equal((await mk('test-sp-a', 'Aardvark Cap')).status, 200);

  const { payload } = await call('GET', '/api/state');
  const names = payload.species.map((s) => s.commonName);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));

  // Two finds pointing at it; deleting the species reports both and leaves
  // the finds as they were, reading as unidentified.
  for (const n of [1, 2]) {
    const id = `test-orphan-${n}`;
    await call('PUT', `/api/observations/${id}`, { id, version: 0, type: 'fungi', speciesId: 'test-sp-a', photos: [] });
  }
  const gone = await call('DELETE', '/api/species/test-sp-a');
  assert.equal(gone.status, 200);
  assert.equal(gone.payload.orphaned, 2);
  const after_ = await call('GET', '/api/state');
  assert.ok(after_.payload.observations.filter((o) => o.speciesId === 'test-sp-a').length === 2);
  assert.ok(!after_.payload.species.some((s) => s.id === 'test-sp-a'));

  for (const n of [1, 2]) await call('DELETE', `/api/observations/test-orphan-${n}`);
  await call('DELETE', '/api/species/test-sp-z');
});

test('config and glossary are single documents with the same version check', async () => {
  const { payload: state } = await call('GET', '/api/state');
  const held = state.config.version;

  const stale = await call('PUT', '/api/config', { version: held - 1, app: { title: 'Nope' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.version, held);

  const saved = await call('PUT', '/api/config', { version: held, app: { ...state.config.app, title: 'Test Notes' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.version, held + 1);
  const next = await call('GET', '/api/state');
  assert.equal(next.payload.config.app.title, 'Test Notes');
  // Merged over what was there, not replaced: the map config survives.
  assert.ok(next.payload.config.map?.tileUrl);

  assert.equal((await call('PUT', '/api/glossary', { version: 0 })).status, 400);
  assert.equal((await call('PUT', '/api/glossary', { version: 0, terms: 'viscid' })).status, 400);
  const gv = next.payload.glossary.version;
  const gl = await call('PUT', '/api/glossary', { version: gv, terms: { viscid: { definition: 'sticky when wet' } } });
  assert.equal(gl.status, 200);
  assert.equal(gl.payload.glossary.version, gv + 1);
  assert.equal(gl.payload.glossary.terms.viscid.definition, 'sticky when wet');
});

// --- photographs ------------------------------------------------------------

// The smallest PNG there is: an 8-byte signature and three chunks.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154' +
  '789c636000010000050001a5f645400000000049454e44ae426082', 'hex');

test('a photograph goes in as bytes and comes back immutable, by its minted name only', async () => {
  const up = await call('POST', '/api/photos', new Uint8Array(PNG), { 'Content-Type': 'image/png' });
  assert.equal(up.status, 201);
  assert.match(up.payload.file, /^[0-9a-f]{16}\.png$/);
  assert.equal(up.payload.bytes, PNG.length);
  assert.equal(up.payload.url, `photos/${up.payload.file}`);

  const down = await call('GET', `/photos/${up.payload.file}`);
  assert.equal(down.status, 200);
  assert.equal(down.headers.get('content-type'), 'image/png');
  assert.match(down.headers.get('cache-control'), /immutable/);
  assert.ok(Buffer.from(down.payload).equals(PNG));

  // Only the minted shape is ever looked up.
  assert.equal((await call('GET', '/photos/../server.js')).status, 404);
  assert.equal((await call('GET', '/photos/server.js')).status, 404);
  assert.equal((await call('GET', '/photos/0000000000000000.png')).status, 404);

  // The extension follows the declared type, never a filename.
  const bad = await call('POST', '/api/photos', new Uint8Array(PNG), { 'Content-Type': 'video/mp4' });
  assert.equal(bad.status, 415);
  const empty = await call('POST', '/api/photos', new Uint8Array(0), { 'Content-Type': 'image/jpeg' });
  assert.equal(empty.status, 400);
});

// --- upstream routes, as far as their validation ---------------------------

test('tile coordinates are bounds-checked before they become a path', async () => {
  assert.equal((await call('GET', '/tiles/20/0/0.png')).status, 400);
  assert.equal((await call('GET', '/tiles/1/2/0.png')).status, 400);
  assert.equal((await call('GET', '/tiles/1/0/2.png')).status, 400);
  assert.equal((await call('GET', '/tiles/a/b/c.png')).status, 404);
});

test('rainfall wants a bounding box the right way up and not wider than the world', async () => {
  assert.equal((await call('GET', '/api/rain')).status, 400);
  assert.equal((await call('GET', '/api/rain?swlat=&swlng=1&nelat=2&nelng=3')).status, 400);
  assert.equal((await call('GET', '/api/rain?swlat=48&swlng=-123&nelat=47&nelng=-122')).status, 400);
  const wide = await call('GET', '/api/rain?swlat=10&swlng=-170&nelat=20&nelng=170');
  assert.equal(wide.status, 200);
  assert.equal(wide.payload.tooWide, true);
  assert.deepEqual(wide.payload.cells, []);
});

test('elevation, taxa search and the photo proxy refuse bad input without asking upstream', async () => {
  assert.equal((await call('GET', '/api/elevation')).status, 400);
  assert.equal((await call('GET', '/api/elevation?lat=91&lon=0')).status, 400);
  assert.equal((await call('GET', '/api/inat/taxa')).status, 400);
  assert.equal((await call('GET', '/api/inat/photo?url=nonsense')).status, 400);
  assert.equal((await call('GET', '/api/inat/photo?url=https://example.com/a.jpg')).status, 403);
  assert.equal((await call('GET', '/api/inat/photo?url=http://static.inaturalist.org/a.jpg')).status, 403);
});

// --- widgets ----------------------------------------------------------------

test('the map widget carries every placed find and the tile contract', async () => {
  const { payload } = await call('GET', '/api/widget/map');
  assert.equal(payload.kind, 'map');
  const { payload: state } = await call('GET', '/api/state');
  const placed = state.observations.filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon));
  assert.equal(payload.pins.length, placed.length);
  assert.equal(payload.of, placed.length);
  assert.equal(payload.tiles, 'tiles/{z}/{x}/{y}.png');
  assert.equal(payload.link, '?view=log&mode=map');
  // Edibility is carried for fungi only.
  for (const pin of payload.pins) {
    if (pin.type !== 'fungi') assert.equal(pin.edibility, '');
  }
});

test('the picture widgets say so when nothing has a photograph', async () => {
  // The example species carry no photographs, so both are honestly empty.
  const sp = await call('GET', '/api/widget/species');
  assert.equal(sp.payload.kind, 'species');
  assert.equal(sp.payload.empty, true);
  const find = await call('GET', '/api/widget/find');
  assert.equal(find.payload.kind, 'find');
  assert.equal(find.payload.empty, true);
  assert.equal((await call('GET', '/api/widget/nope')).status, 404);
});
