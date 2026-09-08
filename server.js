'use strict';

/* ---------------------------------------------------------------------------
 * Field Notes — a local, single-user journal. First view: a nature log.
 *
 * Same shape as `finances`: no dependencies, no build step, all the logic in
 * the browser. The server hands over stored state and writes it back.
 *
 * The one thing it does that finances does not is hold photos. Those are the
 * only binary the app stores, and they are immutable once written — an id is
 * minted per upload and never reused — which is what lets them be served with
 * a long cache and pruned by reachability rather than by bookkeeping.
 * ------------------------------------------------------------------------- */

const http = require('node:http');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { loadEnv } = require('./lib/env.js');
const { createStore, StoreConflict, KEYS: STORE_KEYS } = require('./lib/store.js');
const { IMAGE_TYPES, PHOTO_MIME, PHOTO_NAME, mintPhotoName, referencedPhotos } = require('./lib/photos.js');
const { rainSpacing, latticePoints, rainKey } = require('./lib/rain.js');
const { groundKey, regionBox, bandEdges, sinceYear, contains, inside, sameBox, archiveNeed, taxonIds } = require('./lib/inat.js');
// The cohort edges the Trends view falls back to. Shared with the browser.
const Trends = require('./public/trends.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ENV_PATH = path.join(ROOT, '.env');

// A missing .env is fine; the real environment always wins. See lib/env.js.
loadEnv(ENV_PATH);

// Writable state. Defaults to the project directory, which is the layout when
// running from a checkout. Point STATE_DIR at a mounted volume to containerise
// — and note it must be a *directory*: saves write a temp file and rename over
// the target, which fails against a bind-mounted file.
// The four documents live under it too, at the paths lib/store.js names.
const STATE_DIR = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : ROOT;
const PHOTO_DIR = path.join(STATE_DIR, 'photos');
const TILE_DIR = path.join(STATE_DIR, 'tiles');
const ELEVATION_DIR = path.join(STATE_DIR, 'elevation');
const RAIN_DIR = path.join(STATE_DIR, 'rain');

const PORT = Number(process.env.PORT || 4175);

// Listens on every interface so the log is reachable from the phone the photos
// were taken on. There is no authentication — see the README.
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Phone photos run large, and a HEIC burst frame larger still.
const MAX_PHOTO_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// A bulk import is one walk's worth of finds, not a migration. The body limit
// would stop a bigger one anyway; this makes the refusal say why.
const MAX_BATCH = 500;

// A photo uploaded from a form that was never submitted has nothing pointing at
// it, and would be pruned the moment anything else saved. This is the grace
// period before an unreferenced file is considered abandoned.
const ORPHAN_GRACE_MS = 6 * 60 * 60 * 1000;

// Outside services are asked to identify the caller, and iNaturalist's terms
// ask for a contact address in the agent string.
const USER_AGENT = process.env.FIELDNOTES_USER_AGENT || process.env.TRACKER_USER_AGENT
  || 'FieldNotes/1.0 (personal nature log; https://github.com/)';

// Upstream calls must not hang a page load. Both services are fast when they
// are up and unreachable when they are not; there is no useful middle.
const UPSTREAM_TIMEOUT_MS = 9000;

// --- storage ----------------------------------------------------------------

/*
 * Files under STATE_DIR, or a bucket when S3_BUCKET names one. The bucket is
 * what lets the phone in the field and the laptop at home be the same log.
 */
const store = createStore(process.env, STATE_DIR, PHOTO_DIR);

const readValue = async (key, fallback) => {
  const { value } = await store.read(key);
  return value === undefined ? fallback : value;
};

/**
 * Read, change, write — retrying when another instance writes in between.
 *
 * `change` runs again on a fresh read each time, so a retry re-applies the
 * change to what is there now rather than to the copy it started from. That
 * distinction is the whole point: two instances saving different finds at the
 * same moment is nobody's mistake and should just work, while a stale tab
 * trying to overwrite an edit it never saw has to be reported. The first is a
 * retry, the second is `{ reject }`.
 *
 * `change` must build a fresh value rather than mutating what it was handed,
 * or a retry compounds the previous attempt's edits on top of the new read.
 */
async function mutate(key, fallback, change, attempts = 8) {
  for (let attempt = 1; ; attempt++) {
    const { value, token } = await store.read(key);
    const outcome = await change(value === undefined ? fallback : value);
    if (outcome.reject) return outcome;
    try {
      await store.write(key, outcome.value, token);
      return outcome;
    } catch (err) {
      // Out of attempts, or a real failure. A caller that keeps losing the race
      // is better off being told than looping forever.
      if (!(err instanceof StoreConflict) || attempt >= attempts) throw err;
      // Jittered, so writers who collided once do not line up and collide again.
      await new Promise((r) => setTimeout(r, attempt * 10 + Math.random() * 20));
    }
  }
}

const readConfig = () => readValue('config', undefined);
const readObservations = () => readValue('observations', []);
const readSpecies = () => readValue('species', []);
// What the tag vocabulary means, and any category set by hand. One object
// rather than a collection: it is a single document that is edited in place.
const readGlossary = () => readValue('glossary', { version: 0, terms: {} });

// --- photos -----------------------------------------------------------------
// The name rules and the reachability walk are in lib/photos.js, shared with
// the upload script.

/**
 * A local copy of a photograph held in the bucket.
 *
 * The bucket is the truth, but this app's whole premise is that it works in a
 * forest with no signal. Bytes behind a minted id never change, so a cached
 * copy can never be stale — it is either the photograph or absent.
 */
async function cachePhoto(name, body) {
  try {
    await fsp.mkdir(PHOTO_DIR, { recursive: true });
    const tmp = path.join(PHOTO_DIR, `${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, path.join(PHOTO_DIR, name));
  } catch (err) {
    // A cache that cannot be written is a slow app, not a broken one.
    console.error('photo cache write failed:', err.message);
  }
}

async function loadPhoto(name) {
  const local = await fsp.readFile(path.join(PHOTO_DIR, name)).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (local) return local;
  if (store.kind === 'file') return null;
  const remote = await store.readPhoto(name);
  if (remote) await cachePhoto(name, remote);
  return remote;
}

/**
 * Delete stored photos nothing points at any more.
 *
 * Reachability rather than reference counting: a count has to be maintained
 * correctly at every edit, and one missed decrement leaks a file forever while
 * one extra deletes a photo still on screen. Sweeping from the records cannot
 * drift, because the records are the truth.
 *
 * Failures here are logged and swallowed. A leftover file wastes disk; a
 * delete that throws mid-save would fail a request that already succeeded.
 */
async function pruneOrphanPhotos() {
  try {
    const [observations, species] = await Promise.all([readObservations(), readSpecies()]);
    const keep = referencedPhotos(observations, species);
    const now = Date.now();

    for (const { name, modified } of await store.listPhotos()) {
      if (!PHOTO_NAME.test(name) || keep.has(name)) continue;
      // Young and unreferenced means "sitting in a form that has not been
      // submitted yet", not "abandoned".
      if (now - modified < ORPHAN_GRACE_MS) continue;
      await store.deletePhoto(name);
    }

    /*
     * The local cache is swept on the same rule but without the grace period:
     * a cached copy of something no record points at is dead weight, and
     * deleting it loses nothing — the bucket still holds the photograph, and
     * on a versioned bucket it holds the deleted ones too.
     */
    if (store.kind !== 'file') {
      const cached = await fsp.readdir(PHOTO_DIR).catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
      });
      for (const name of cached) {
        if (!PHOTO_NAME.test(name) || keep.has(name)) continue;
        await fsp.unlink(path.join(PHOTO_DIR, name)).catch(() => {});
      }
    }
  } catch (err) {
    console.error('photo prune failed:', err.message);
  }
}

// --- outside services -------------------------------------------------------
/*
 * Two upstreams, both proxied rather than called from the page.
 *
 * That is a deliberate choice. Going through the server means the browser makes
 * no third-party requests at all — the map does not hand a tile server a
 * running log of where you have been looking — and it lets tiles be cached to
 * disk, so ground you have already looked at still draws with no signal. Which
 * is the case this app is actually used in.
 */

/** fetch with a timeout, so a dead upstream cannot pin a request open. */
async function upstream(url, { accept, timeout } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept || 'application/json' },
    signal: AbortSignal.timeout(timeout || UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`upstream ${res.status}`);
    err.upstream = res.status;
    throw err;
  }
  return res;
}

// --- tiles ---

// z/x/y straight out of a URL become a filesystem path, so they are parsed as
// integers and bounds-checked against the pyramid rather than pattern-matched.
function parseTileCoords(z, x, y) {
  const zoom = Number(z), tx = Number(x), ty = Number(y);
  if (![zoom, tx, ty].every(Number.isSafeInteger)) return null;
  if (zoom < 0 || zoom > 19) return null;
  const span = 2 ** zoom;
  if (tx < 0 || tx >= span || ty < 0 || ty >= span) return null;
  return { zoom, tx, ty };
}

/**
 * One map tile, from disk if it has ever been fetched.
 *
 * Tiles are immutable enough for this purpose — OpenStreetMap redraws them as
 * the map is edited, but a footpath moving is not worth a revalidation round
 * trip on every pan. Delete the tiles directory to refresh them.
 */
async function serveTile(res, coords, template) {
  const { zoom, tx, ty } = coords;
  const file = path.join(TILE_DIR, String(zoom), String(tx), `${ty}.png`);

  const send = (data, source) => {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=604800',
      'X-Tile-Source': source,
    });
    res.end(data);
  };

  const cached = await fsp.readFile(file).catch(() => null);
  if (cached) return send(cached, 'cache');

  const url = template
    .replace('{z}', zoom).replace('{x}', tx).replace('{y}', ty)
    // Some tile servers shard across subdomains. Pick one deterministically so
    // a given tile always resolves to the same host, and so caches downstream
    // are not fragmented three ways.
    .replace('{s}', 'abc'[(tx + ty) % 3]);

  let body;
  try {
    const upstreamRes = await upstream(url, { accept: 'image/png,image/*' });
    body = Buffer.from(await upstreamRes.arrayBuffer());
  } catch (err) {
    // No tile is not an error worth a red banner: the map draws its own grid
    // and the pins are still in the right places.
    res.writeHead(504, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ error: `tile unavailable: ${err.message}` }));
  }

  await fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  await fsp.writeFile(file, body).catch(() => {});
  return send(body, 'upstream');
}

// --- ground elevation ---

/*
 * What the ground is doing under a find, when the photographs did not say.
 *
 * A phone usually writes GPSAltitude and that is the better number — it was
 * measured where you stood. This is the fallback: the USGS 3DEP terrain model,
 * which answers with the elevation of the ground at a coordinate. Free, no
 * key, and US-only, which is a real limit worth knowing about rather than
 * papering over.
 *
 * Note that the two are not the same measurement. GPSAltitude is where the
 * camera was; this is where the ground is. On a slope they differ by more than
 * either one's error bar, which is why the source travels with the number.
 */
const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';

// 4 decimal places is about 11m, which is finer than the 10m model underneath
// and far finer than a GPS fix under a canopy. Rounding is what makes the
// cache worth having: two finds from the same log jam share an answer.
const ELEVATION_PRECISION = 4;

// A sanity range, not a claim about the terrain: services of this kind signal
// "no data" with a sentinel value rather than an error, and a number far
// outside anything the Earth does is the tell.
const ELEVATION_MIN_M = -500;
const ELEVATION_MAX_M = 9000;

/*
 * The other way it says "no data" is a flat 0.000000000, which it will return
 * for a hole in the model with no error and no flag. A coordinate in the
 * Olympic foothills came back that way while the photographs of the same find
 * said 364m.
 *
 * Sea level is a real elevation and this is a coast, so nothing distinguishes
 * the two by value. But a metre-resolution lidar raster does not put real
 * ground at exactly zero — it puts it at 0.34, or -0.12 — so an exact zero is
 * a good sentinel. Treating it as no-data costs a genuine tideline find its
 * elevation, which it did not have before either; trusting it would print
 * "~0 m" under a photograph taken well up a mountain.
 */
const isNoData = (value) => value === 0;

/*
 * EPQS is slow in a way the other upstreams are not: it queries a raster per
 * point, and twenty seconds is an ordinary reply rather than a sick one. The
 * nine-second budget the rest of the app uses is right for a tile the map is
 * waiting on and wrong here, where nothing is waiting — the number arrives as
 * a footnote on a card that is already drawn.
 */
const ELEVATION_TIMEOUT_MS = 30000;

// Misses stay in memory and never reach the disk. Only a service that answered
// is remembered: a coordinate it had no data for will still have none in an
// hour, whereas a timeout says nothing about the coordinate at all, and
// caching one would lock a find out of an answer it could have had.
const elevationMisses = new Map();
const ELEVATION_MISS_TTL_MS = 60 * 60 * 1000;

function elevationKey(lat, lon) {
  return `${lat.toFixed(ELEVATION_PRECISION)}_${lon.toFixed(ELEVATION_PRECISION)}`;
}

/**
 * Ground elevation at a coordinate, from disk if it has ever been asked for.
 *
 * Cached one file per rounded coordinate, the way tiles are: terrain does not
 * move, so a hit is good forever, and the file layout means no locking and no
 * index to keep straight. Returns null when there is no answer to be had.
 */
async function groundElevation(lat, lon) {
  const key = elevationKey(lat, lon);
  const file = path.join(ELEVATION_DIR, `${key}.json`);

  const cached = await fsp.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (cached && Number.isFinite(cached.metres)) return { ...cached, cache: 'disk' };

  const missed = elevationMisses.get(key);
  if (missed && Date.now() - missed < ELEVATION_MISS_TTL_MS) return null;

  const query = new URLSearchParams({ x: String(lon), y: String(lat), units: 'Meters', wkid: '4326' });
  let metres = null;
  let answered = false;
  try {
    const payload = await upstream(`${EPQS_URL}?${query}`, { timeout: ELEVATION_TIMEOUT_MS }).then((r) => r.json());
    answered = true;
    // v1 has answered with the value both as a number and as a string.
    const value = Number(payload?.value);
    if (Number.isFinite(value) && !isNoData(value) && value >= ELEVATION_MIN_M && value <= ELEVATION_MAX_M) metres = value;
  } catch {
    // An unreachable elevation service is not an error the log needs to hear
    // about, and not a fact about this coordinate either.
  }

  if (metres === null) {
    if (answered) {
      elevationMisses.set(key, Date.now());
      if (elevationMisses.size > 500) elevationMisses.delete(elevationMisses.keys().next().value);
    }
    return null;
  }

  const record = { metres: Math.round(metres), source: 'usgs-3dep', lat: Number(lat.toFixed(ELEVATION_PRECISION)), lon: Number(lon.toFixed(ELEVATION_PRECISION)) };
  await fsp.mkdir(ELEVATION_DIR, { recursive: true }).catch(() => {});
  await fsp.writeFile(file, JSON.stringify(record)).catch(() => {});
  return { ...record, cache: 'upstream' };
}

// --- recent rainfall ---

/*
 * Where it has already rained, which is a different question from where it is
 * going to.
 *
 * Every free weather API answers the second one, because a forecast is what
 * most callers want. A forager wants the first: a fungus fruits days after the
 * water arrives, so the useful map is of ground that is already wet. Open-Meteo
 * will answer backwards — `past_days` fills in observed days on the same
 * endpoint that serves forecasts — and it does it without a key, which is what
 * makes it usable from a server that is otherwise nobody's customer.
 *
 * The data is reanalysis, not a rain gauge in that clearing. Over a week and at
 * this grid spacing that is the right resolution anyway: the answer being
 * looked for is "which drainage got soaked", not "how wet is this log".
 */
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// Open-Meteo takes comma-separated coordinates, so a screenful is three or
// four requests rather than three hundred. The limit is politeness, not a
// documented cap.
const RAIN_BATCH = 100;

const RAIN_DEFAULT_DAYS = 7;
const RAIN_MAX_DAYS = 92;

/** The server's own local date, which is the day the cached window belongs to. */
function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/*
 * The window is whole days ending yesterday, never including today.
 *
 * Today is half-measured and revises upward all afternoon, so including it
 * would make the same cell answer differently before and after dinner and make
 * every cached cell stale the moment it was written. Ending at midnight gives a
 * window that is fixed until the date rolls over, which is what makes a
 * one-file-per-cell cache worth having at all.
 */
async function rainCell(point, days) {
  const file = path.join(RAIN_DIR, `${rainKey(point.lat, point.lon)}.json`);
  const cached = await fsp.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (cached && cached.on === today() && cached.days === days && Number.isFinite(cached.inches)) {
    return { ...point, inches: cached.inches, from: cached.from, to: cached.to };
  }
  return null;
}

/** Ask Open-Meteo about a batch of points at once, and write each one down. */
async function fetchRainBatch(points, days) {
  const query = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lon).join(','),
    daily: 'precipitation_sum',
    past_days: String(days),
    // Complete days only. See the note above rainCell.
    forecast_days: '0',
    // Per-point local days: a day boundary in the Cascades is not a day
    // boundary in Maine, and the totals should follow the ground.
    timezone: 'auto',
    precipitation_unit: 'inch',
  });

  const payload = await upstream(`${OPEN_METEO_URL}?${query}`).then((r) => r.json());
  // One location comes back as an object, several as an array. Normalising is
  // cheaper than a special case at every use.
  const series = Array.isArray(payload) ? payload : [payload];

  const out = [];
  const stamp = today();
  for (let i = 0; i < points.length; i++) {
    const daily = series[i]?.daily;
    const totals = daily?.precipitation_sum;
    if (!Array.isArray(totals) || !totals.length) continue;

    // A null in the series is a day the model had nothing for, which is not the
    // same as a dry day. Summing it as zero would quietly under-report a week.
    if (totals.some((v) => v === null || v === undefined)) continue;
    const inches = Number(totals.reduce((sum, v) => sum + Number(v), 0).toFixed(2));
    if (!Number.isFinite(inches)) continue;

    const dates = daily.time || [];
    const cell = { ...points[i], inches, from: dates[0] || null, to: dates[dates.length - 1] || null };
    out.push(cell);
    await fsp.writeFile(path.join(RAIN_DIR, `${rainKey(cell.lat, cell.lon)}.json`),
      JSON.stringify({ on: stamp, days, inches, from: cell.from, to: cell.to })).catch(() => {});
  }
  return out;
}

/**
 * Rainfall totals over the last whole `days`, on a lattice covering `box`.
 *
 * Returns whatever it has: a batch that fails contributes nothing and the rest
 * of the map still draws. A rain layer with a hole in it is more use than no
 * rain layer, and the hole is visible as one.
 */
async function recentRainfall(box, days) {
  const spacing = rainSpacing(box);
  // Nothing to draw and nothing wrong: the viewport is simply wider than this
  // many samples can describe, and the caller says so rather than shading it.
  if (spacing === null) return { spacing: 0, cells: [], tooWide: true, problem: null };

  const points = latticePoints(box, spacing);
  if (!points.length) return { spacing, cells: [], problem: null };

  await fsp.mkdir(RAIN_DIR, { recursive: true }).catch(() => {});

  const cells = [];
  const wanted = [];
  for (const point of points) {
    const hit = await rainCell(point, days);
    if (hit) cells.push(hit); else wanted.push(point);
  }

  // Concurrently, and independently: the batches do not need each other, and a
  // screenful of fresh ground is six sequential round trips if they wait in
  // line. One that fails takes only its own points down with it — the rest of
  // the map still draws, with a hole where that batch would have been.
  const batches = [];
  for (let i = 0; i < wanted.length; i += RAIN_BATCH) {
    batches.push(wanted.slice(i, i + RAIN_BATCH));
  }
  const settled = await Promise.allSettled(batches.map((batch) => fetchRainBatch(batch, days)));

  let failed = 0;
  let reason = '';
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') cells.push(...outcome.value);
    else { failed++; reason = outcome.reason?.message || 'unknown error'; }
  }

  // Said only when something is actually missing from the picture. A total
  // failure and a partial one read differently on a map, so they say so
  // differently.
  const problem = !failed ? null
    : failed === settled.length ? `rainfall data unavailable: ${reason}`
    : 'Part of this view could not be checked for rainfall.';

  return { spacing, cells, problem };
}

// --- iNaturalist ---

const INAT_BASE = 'https://api.inaturalist.org/v1';

// A short-lived in-memory cache. Panning a map re-asks for overlapping boxes
// constantly, and iNaturalist asks callers not to hammer it.
const inatCache = new Map();
const INAT_TTL_MS = 5 * 60 * 1000;

async function inatGet(pathAndQuery) {
  const hit = inatCache.get(pathAndQuery);
  if (hit && Date.now() - hit.at < INAT_TTL_MS) return hit.value;

  const res = await upstream(`${INAT_BASE}${pathAndQuery}`);
  const value = await res.json();
  inatCache.set(pathAndQuery, { at: Date.now(), value });
  // Bounded so a long session cannot grow it without limit.
  if (inatCache.size > 200) inatCache.delete(inatCache.keys().next().value);
  return value;
}

// iNaturalist's iconic taxa are finer-grained than this app's three kingdoms.
// Anything not listed is left null and dropped rather than guessed at.
const ICONIC_TO_TYPE = {
  Fungi: 'fungi', Protozoa: null, Chromista: null,
  Plantae: 'flora',
  Animalia: 'fauna', Insecta: 'fauna', Arachnida: 'fauna', Mollusca: 'fauna',
  Aves: 'fauna', Mammalia: 'fauna', Reptilia: 'fauna', Amphibia: 'fauna',
  Actinopterygii: 'fauna',
};

/** Rewrite an upstream image URL to go back through this server. */
const proxiedPhoto = (url) => (url ? `api/inat/photo?url=${encodeURIComponent(url)}` : null);

/** Only the fields the map and the species editor actually draw. */
function slimObservation(o) {
  const type = ICONIC_TO_TYPE[o.taxon?.iconic_taxon_name] ?? null;
  if (!type) return null;
  // `geojson` is [lon, lat]. An obscured record still carries a point, but a
  // deliberately randomised one — it is passed through and flagged rather than
  // dropped, so the pin is honest about being approximate.
  const point = o.geojson?.coordinates;
  if (!Array.isArray(point) || point.length !== 2) return null;
  return {
    id: `inat-${o.id}`,
    lat: point[1],
    lon: point[0],
    type,
    commonName: o.taxon?.preferred_common_name || null,
    scientificName: o.taxon?.name || null,
    taxonId: o.taxon?.id ?? null,
    observedOn: o.observed_on || null,
    photo: proxiedPhoto(o.photos?.[0]?.url ? o.photos[0].url.replace('/square.', '/small.') : null),
    by: o.user?.login || null,
    url: `https://www.inaturalist.org/observations/${o.id}`,
    obscured: !!o.obscured,
  };
}

function slimTaxon(t) {
  return {
    id: t.id,
    scientificName: t.name,
    commonName: t.preferred_common_name || null,
    rank: t.rank || null,
    type: ICONIC_TO_TYPE[t.iconic_taxon_name] ?? null,
    photo: proxiedPhoto(t.default_photo?.medium_url || t.default_photo?.square_url || null),
    observations: t.observations_count ?? null,
    wikipedia: t.wikipedia_url || null,
  };
}

// --- the iNaturalist archive ---

/*
 * Every research-grade record of a taxon across the home region, kept on
 * disk.
 *
 * Two things want it. The Trends view needs years of records at once and
 * cannot page through iNaturalist on every visit; and the map, which used to
 * ask afresh for every pan, can answer from disk whenever the viewport is
 * inside the region and the taxon has been archived. Neither is served a
 * stale-by-months copy: an archive is topped up with anything newer once a
 * day, and rebuilt from nothing once a month, which is what catches records
 * that were deleted, re-identified or promoted to research grade after they
 * were first seen.
 *
 * One file per taxon, written after every page, so a sync that is interrupted
 * — the laptop closed — resumes where it stopped. Records carry their stated
 * positional accuracy alongside the fields the map draws, because the
 * altitude cohorts have to know how far a point can be trusted. Ground
 * elevations are shared across taxa in one further file keyed by rounded
 * coordinate: chanterelles and matsutake grow on the same hills.
 *
 * Elevations come from Open-Meteo rather than the USGS model the finds use.
 * That one answers a point in twenty seconds; this one answers a hundred in
 * one round trip, from a 90m global model, which is the right tool for five
 * thousand points that only need placing in a band several hundred metres
 * wide.
 */
const INAT_DIR = path.join(STATE_DIR, 'inat');
const GROUND_FILE = path.join(INAT_DIR, 'ground.json');
const archiveFile = (taxonId) => path.join(INAT_DIR, `${taxonId}.json`);

const INAT_PAGE = 200;
// iNaturalist asks for no more than about one request a second and sixty a
// minute. A page a second stays inside that, with room left for the map.
const INAT_PAGE_GAP_MS = 1100;
// Per run, not per taxon: a bigger archive carries on next time it is asked
// for. Thirty thousand records is many times any fungus worth foraging.
const INAT_MAX_PAGES = 150;
// A failed sync is not retried on the next page load. It waits.
const INAT_RETRY_MS = 60 * 1000;

const OPEN_METEO_ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';
// Open-Meteo takes up to a hundred coordinates in one request — but counts
// each coordinate against its limit of six hundred a minute, which a batch
// every three hundred milliseconds found out in six batches. Eleven seconds a
// batch is five hundred and fifty a minute: a three-thousand-record taxon is
// four minutes of background work, once.
const GROUND_BATCH = 100;
const GROUND_GAP_MS = 11000;
// Told to slow down, wait this long and try again, a few times.
const RATE_LIMIT_WAIT_MS = 60 * 1000;
const RATE_LIMIT_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file, fallback) => fsp.readFile(file, 'utf8').then(JSON.parse).catch(() => fallback);

/** Write a file whole or not at all, the way the store does. */
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}

const readArchive = (taxonId) => readJson(archiveFile(taxonId), null);
const readGround = () => readJson(GROUND_FILE, {});

/**
 * An upstream JSON call that takes a 429 as an instruction rather than an
 * answer: wait as long as asked, or a minute, and go again. Anything else
 * still fails at once — a service that is down is not one to keep knocking
 * on.
 */
async function patientJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await upstream(url).then((r) => r.json());
    } catch (err) {
      if (err.upstream !== 429 || attempt >= RATE_LIMIT_ATTEMPTS) throw err;
      await sleep(RATE_LIMIT_WAIT_MS);
    }
  }
}

/** The map's slim record, plus how far the point can be trusted. */
function archiveRecord(o) {
  const slim = slimObservation(o);
  if (!slim) return null;
  const acc = Number(o.positional_accuracy);
  return { ...slim, acc: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
}

// Syncs in flight or recently failed, by taxon, so the map and the Trends view
// asking about the same taxon share one. `progress` is what a client polling
// meanwhile is shown.
const inatSyncs = new Map();
// One upstream conversation at a time across every taxon: politeness is a
// property of the server, not of a request.
let inatQueue = Promise.resolve();

/** Whether every unobscured record in a list has a ground elevation on file. */
function groundComplete(observations, ground) {
  return observations.every((o) => o.obscured || Number.isFinite(ground[groundKey(o.lat, o.lon)]));
}

/**
 * The archive for one taxon as it stands now, and the sync bringing it up to
 * date if one is needed. Starts that sync — in the background, queued behind
 * any other — but never waits on it: a client asks again in a moment and is
 * shown what has landed so far.
 *
 * `archive` is null when what is on disk is for a different region or too old
 * to trust, which is when a rebuild begins.
 *
 * The ground under the records is looked up only when asked for. The map
 * has no use for it, and a bird picked on the map can have thirty thousand
 * records in the region — more coordinates than Open-Meteo allows in a day,
 * spent on a question nobody asked.
 */
async function ensureArchive(taxonId, region, { wantGround = false } = {}) {
  let held = await readArchive(taxonId);
  const wanting = async () => {
    const need = archiveNeed(held, region);
    if (need !== 'none' || !wantGround || !held) return need;
    return groundComplete(held.observations, await readGround()) ? 'none' : 'ground';
  };
  let need = await wanting();

  const running = inatSyncs.get(taxonId);
  if (running?.error && Date.now() - running.failedAt >= INAT_RETRY_MS) inatSyncs.delete(taxonId);
  // A copy that is stale here may be fresh in the bucket — another instance
  // may have built it since. Worth one look before fetching it all again,
  // and it is one look: a sync then starts, or the copy is fresh, and either
  // way the next request does not look again.
  if (need !== 'none' && !inatSyncs.has(taxonId)) {
    const adopted = await adoptFromBucket(taxonId, held, region);
    if (adopted !== held) { held = adopted; need = await wanting(); }
  }
  if (need !== 'none' && !inatSyncs.has(taxonId)) startSync(taxonId, region, need, held, wantGround);

  const sync = inatSyncs.get(taxonId);
  return { archive: need === 'full' ? null : held, sync: sync ? sync.progress : null };
}

function startSync(taxonId, region, need, held, wantGround) {
  const progress = {
    taxonId, phase: 'records',
    fetched: need === 'full' ? 0 : held.observations.length, total: null,
    ground: 0, groundTotal: 0, error: null,
  };
  const entry = { progress, error: null, failedAt: 0 };
  inatSyncs.set(taxonId, entry);
  const run = inatQueue
    .then(() => syncArchive(taxonId, region, need, held, progress, wantGround))
    .then(() => { inatSyncs.delete(taxonId); })
    .catch((err) => {
      // Left in place, marked, so the next request does not immediately try
      // again against a service that just refused.
      progress.error = err.message;
      entry.error = err.message;
      entry.failedAt = Date.now();
      console.error(`iNaturalist archive for taxon ${taxonId}: ${err.message}`);
    });
  inatQueue = run;
}

/**
 * Fetch, in id order and a page at a time, everything the archive does not
 * yet hold; then the ground under it.
 *
 * Ascending by id with `id_above` is the one way through iNaturalist's index
 * that has no ceiling — offset paging stops at ten thousand — and it makes a
 * top-up the same loop as a first fetch, started from the last id seen.
 */
async function syncArchive(taxonId, region, need, held, progress, wantGround) {
  const archive = need === 'full'
    ? { taxonId, region, startedAt: new Date().toISOString(), syncedAt: null, complete: false, maxId: 0, observations: [] }
    : { ...held, observations: held.observations.slice() };

  if (need !== 'ground') {
    archive.complete = false;
    const known = new Set(archive.observations.map((o) => o.id));
    let idAbove = archive.maxId || 0;
    for (let page = 0; page < INAT_MAX_PAGES; page++) {
      const query = new URLSearchParams({
        swlat: String(region.swlat), swlng: String(region.swlng), nelat: String(region.nelat), nelng: String(region.nelng),
        taxon_id: String(taxonId),
        quality_grade: 'research', photos: 'true', geo: 'true',
        order_by: 'id', order: 'asc', per_page: String(INAT_PAGE), id_above: String(idAbove),
      });
      const payload = await patientJson(`${INAT_BASE}/observations?${query}`);
      const results = payload.results || [];
      if (progress.total == null) progress.total = archive.observations.length + (Number(payload.total_results) || results.length);
      for (const o of results) {
        if (Number.isFinite(o.id)) idAbove = Math.max(idAbove, o.id);
        const record = archiveRecord(o);
        if (record && !known.has(record.id)) {
          known.add(record.id);
          archive.observations.push(record);
        }
      }
      archive.maxId = idAbove;
      progress.fetched = archive.observations.length;
      const done = results.length < INAT_PAGE;
      if (done) {
        archive.complete = true;
        archive.syncedAt = new Date().toISOString();
      }
      await writeJson(archiveFile(taxonId), archive);
      if (done) break;
      await sleep(INAT_PAGE_GAP_MS);
    }
    if (archive.complete) {
      await pushArchive(archive).catch((err) => console.error(`iNaturalist archive for taxon ${taxonId}: bucket ${err.message}`));
    }
  }

  if (wantGround) {
    progress.phase = 'ground';
    await groundUnder(archive.observations, progress);
  }
  progress.phase = 'done';
}

/**
 * Ground elevations for every unobscured record that lacks one, a hundred
 * coordinates a request, written down after each batch so nothing is asked
 * twice. An obscured record's point is deliberately wrong and is not looked
 * up: it would be the elevation of somewhere else.
 */
async function groundUnder(observations, progress) {
  const ground = await readGround();
  const wanted = [];
  const seen = new Set();
  for (const o of observations) {
    if (o.obscured) continue;
    const key = groundKey(o.lat, o.lon);
    if (Number.isFinite(ground[key]) || seen.has(key)) continue;
    seen.add(key);
    wanted.push(key);
  }
  progress.groundTotal = wanted.length;
  progress.ground = 0;

  for (let i = 0; i < wanted.length; i += GROUND_BATCH) {
    const batch = wanted.slice(i, i + GROUND_BATCH);
    const lats = [], lons = [];
    for (const key of batch) {
      const [lat, lon] = key.split('_');
      lats.push(lat);
      lons.push(lon);
    }
    const query = new URLSearchParams({ latitude: lats.join(','), longitude: lons.join(',') });
    const payload = await patientJson(`${OPEN_METEO_ELEVATION_URL}?${query}`);
    const answers = Array.isArray(payload?.elevation) ? payload.elevation : [];
    if (answers.length !== batch.length) throw new Error('elevation service answered the wrong number of points');
    batch.forEach((key, j) => {
      const metres = Number(answers[j]);
      if (Number.isFinite(metres)) ground[key] = Math.round(metres);
    });
    await writeJson(GROUND_FILE, ground);
    progress.ground = Math.min(wanted.length, i + batch.length);
    if (i + GROUND_BATCH < wanted.length) await sleep(GROUND_GAP_MS);
  }
  // Pushed whether or not anything was new: the ground under an archive
  // that was built before the bucket held one has to get there somehow, and
  // a daily merge of a small file is the cheap way.
  await pushGround(ground).catch((err) => console.error(`iNaturalist ground elevations: bucket ${err.message}`));
}

// --- sharing the archive through the bucket ---

/*
 * With a bucket, the archive lives there and inat/ on disk is a cache, the
 * way photos/ is: the bucket is the truth, but a copy already on disk is read
 * at disk speed and the bucket is consulted only when that copy is stale by
 * the archive's own daily rule. So a second instance — the laptop, after the
 * container built the archive — gets a species in one GET rather than four
 * minutes of upstream fetching, and both spend one Open-Meteo allowance on
 * the same hills rather than two.
 *
 * Pages land on disk as they arrive, as before. The bucket sees an archive
 * only once its records are complete, and the ground once that phase is done,
 * so another instance never adopts a half-built copy. Two instances building
 * the same taxon at once is settled by the store's conditional put: the loser
 * reads what won and keeps it if it is the fuller copy.
 *
 * Without a bucket none of this runs, and inat/ is simply where the archive
 * is.
 */
const SHARED = store.kind === 's3';
const archiveDoc = (taxonId) => `inat/${taxonId}.json`;
const GROUND_DOC = 'inat/ground.json';

/**
 * Whether one copy of an archive is worth more than another: complete beats
 * partial, a later sync beats an earlier one, and more records beat fewer
 * while both are still being built. Nothing beats a copy for another region.
 */
function fuller(candidate, held, region) {
  if (!candidate || !sameBox(candidate.region, region)) return false;
  if (!held || !sameBox(held.region, region)) return true;
  if (!!candidate.complete !== !!held.complete) return !!candidate.complete;
  if (candidate.complete) return (candidate.syncedAt || '') > (held.syncedAt || '');
  return (candidate.maxId || 0) > (held.maxId || 0);
}

/**
 * The bucket's copy of an archive, adopted onto disk when it is the fuller
 * one; otherwise what was held. The ground under it comes along, because a
 * record without its elevation is a record the Trends view cannot place.
 */
async function adoptFromBucket(taxonId, held, region) {
  if (!SHARED) return held;
  try {
    const { value: remote } = await store.read(archiveDoc(taxonId));
    if (!fuller(remote, held, region)) return held;
    await writeJson(archiveFile(taxonId), remote);
    await pullGround();
    return remote;
  } catch (err) {
    // The bucket being unreachable is not a reason to stop: the copy on
    // disk, or a fresh fetch, still answers.
    console.error(`iNaturalist archive for taxon ${taxonId}: bucket ${err.message}`);
    return held;
  }
}

/** The bucket's ground elevations, folded into the copy on disk. */
async function pullGround() {
  const { value: remote } = await store.read(GROUND_DOC);
  if (!remote || typeof remote !== 'object') return;
  const local = await readGround();
  await writeJson(GROUND_FILE, { ...remote, ...local });
}

/**
 * Put a finished archive in the bucket, unless what is there is fuller —
 * another instance finished first, and the next request adopts its copy.
 */
async function pushArchive(archive) {
  if (!SHARED) return;
  const key = archiveDoc(archive.taxonId);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { value: remote, token } = await store.read(key);
    if (fuller(remote, archive, archive.region)) return;
    try {
      await store.write(key, archive, token);
      return;
    } catch (err) {
      if (!(err instanceof StoreConflict) || attempt === 3) throw err;
    }
  }
}

/**
 * Put the ground elevations in the bucket, as a union with whatever is there:
 * two instances looking up different hills are both right.
 */
async function pushGround(ground) {
  if (!SHARED) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { value: remote, token } = await store.read(GROUND_DOC);
    const merged = { ...(remote && typeof remote === 'object' ? remote : {}), ...ground };
    try {
      await store.write(GROUND_DOC, merged, token);
      return;
    } catch (err) {
      if (!(err instanceof StoreConflict) || attempt === 3) throw err;
    }
  }
}


/**
 * The map's answer from the archive: the newest records inside a viewport,
 * for taxa whose archives are complete. Null when any is not, which sends the
 * request upstream the way it always went — and warms the archive for next
 * time, because asking is what starts a sync.
 */
async function fromArchive(ids, box, region, perPage) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const { archive } = await ensureArchive(id, region);
    if (!archive?.complete) return null;
    for (const o of archive.observations) {
      if (seen.has(o.id) || !inside(box, o.lat, o.lon)) continue;
      seen.add(o.id);
      const { acc, ...slim } = o;
      out.push(slim);
    }
  }
  // Newest first, undated last: the order iNaturalist's own `observed_on`
  // sort gives the map.
  out.sort((a, b) => (b.observedOn || '').localeCompare(a.observedOn || ''));
  return { total: out.length, results: out.slice(0, perPage) };
}

// --- widgets ----------------------------------------------------------------
/*
 * What a phone's home screen needs, already decided.
 *
 * A widget wakes on the system's schedule, draws once, and remembers nothing
 * between refreshes. So the choosing happens here: pulling four hundred
 * species down to a home screen in order to pick one of them would be doing it
 * from the wrong end, and the phone is the end with the metered connection.
 *
 * Each answer carries a `link` — the query the browser understands, the same
 * one the app itself puts in the address bar when that record is open. That is
 * the whole contract between a widget and the app: a photograph, a caption,
 * and where tapping it goes.
 */

/** One at random, or null from an empty list. */
const pick = (list) => (list.length ? list[Math.floor(Math.random() * list.length)] : null);

// A widget draws at a few hundred pixels. The stored preview is a plain JPEG
// of at most 1000, which is both smaller over the wire and — for a HEIC from
// an iPhone — the only copy anything but Safari can decode.
const WIDGET_DISPLAYABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

/**
 * A photograph from one record, at a size worth sending to a phone.
 *
 * Random rather than the cover shot: the cover is the one you have already
 * seen, and a widget that shows the same frame every time is a picture, not a
 * window into the log.
 */
function widgetPhoto(record) {
  const usable = (record.photos || [])
    .map((p) => (p.thumb ? { ...p, src: `photos/${p.thumb}` }
      : WIDGET_DISPLAYABLE.has(p.mime) ? { ...p, src: `photos/${p.file}` } : null))
    .filter(Boolean);
  const photo = pick(usable);
  if (!photo) return null;
  return {
    photo: photo.src,
    // Somebody else's photograph carries a licence that asks to be credited,
    // and a widget is as public a place as the app is.
    credit: photo.attribution || null,
  };
}

/** A random species that has an example photograph, and how many there were. */
async function speciesWidget() {
  const species = await readSpecies();
  const candidates = species.map((s) => ({ record: s, shot: widgetPhoto(s) })).filter((c) => c.shot);
  const chosen = pick(candidates);
  if (!chosen) return { kind: 'species', of: 0, empty: true };

  const s = chosen.record;
  return {
    kind: 'species',
    of: candidates.length,
    id: s.id,
    name: s.commonName || s.scientificName || 'Unnamed',
    scientificName: s.scientificName || '',
    type: s.kind || null,
    edibility: s.edibility || 'unknown',
    ...chosen.shot,
    link: `?view=species&species=${encodeURIComponent(s.id)}`,
  };
}

/**
 * A random find that has a photograph.
 *
 * The name is derived the way `Model.displayName` derives it — a dangling
 * species id reads as unidentified, and a low-confidence call keeps its
 * question mark. A widget must not quietly promote a guess to an answer.
 */
async function findWidget() {
  const [observations, species] = await Promise.all([readObservations(), readSpecies()]);
  const index = new Map(species.map((s) => [s.id, s]));
  const candidates = observations.map((o) => ({ record: o, shot: widgetPhoto(o) })).filter((c) => c.shot);
  const chosen = pick(candidates);
  if (!chosen) return { kind: 'find', of: 0, empty: true };

  const o = chosen.record;
  const sp = o.speciesId ? index.get(o.speciesId) || null : null;
  // A find identified as one of its species' closely related names goes by
  // that name, exactly as the app draws it.
  const relative = sp ? String(o.relative || '').trim() : '';
  const base = sp ? (relative || sp.commonName || sp.scientificName || 'Unidentified') : 'Unidentified';
  return {
    kind: 'find',
    of: candidates.length,
    id: o.id,
    name: sp && o.confidence === 'low' ? `${base}?` : base,
    scientificName: sp ? relative || sp.scientificName || '' : '',
    type: sp ? sp.kind : o.type,
    edibility: sp ? sp.edibility || 'unknown' : 'unknown',
    when: o.observedAt || null,
    place: o.place || null,
    ...chosen.shot,
    link: `?view=log&find=${encodeURIComponent(o.id)}`,
  };
}

/**
 * Every find that carries a location, and where to draw them.
 *
 * Only your own records: the crowd-sourced pins are fetched for one species at
 * a time in response to what is on screen, and a home screen has nothing on
 * screen to respond to. The widget composes its own basemap out of `/tiles`,
 * so the template goes with them — a widget pointed at a log with no tile
 * source configured should draw the pins on nothing rather than fail.
 */
async function mapWidget() {
  const [config, observations, species] = await Promise.all([
    readConfig(), readObservations(), readSpecies(),
  ]);
  const index = new Map(species.map((s) => [s.id, s]));
  const map = config.map || {};

  const pins = observations
    .filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon))
    .map((o) => {
      const sp = o.speciesId ? index.get(o.speciesId) || null : null;
      return {
        id: o.id,
        lat: o.lat,
        lon: o.lon,
        type: sp ? sp.kind : o.type,
        // Fungi only, exactly as the map does it: edibility is the thing worth
        // reading off a map at a glance, and only for the kingdom it decides.
        edibility: (sp ? sp.kind : o.type) === 'fungi' ? (sp?.edibility || 'unknown') : '',
      };
    });

  return {
    kind: 'map',
    of: pins.length,
    tiles: map.tileUrl ? 'tiles/{z}/{x}/{y}.png' : null,
    attribution: map.attribution || '',
    minZoom: map.minZoom ?? 2,
    maxZoom: map.maxZoom ?? 19,
    default: map.default || { lat: 0, lon: 0, zoom: 2 },
    // The kingdom colours are configurable; the widget carries the edibility
    // palette itself, the way the stylesheet does.
    types: config.theme?.types || {},
    pins,
    link: '?view=log&mode=map',
  };
}

// --- collections ------------------------------------------------------------

/**
 * Upsert one record into a JSON array file, with the same optimistic
 * concurrency finances uses: the client echoes the version it loaded, and a
 * mismatch means another tab or another device wrote first. Rejecting is the
 * only safe answer — the alternative is silently discarding their edit.
 */
function upsert({ list, id, incoming, sortKey }) {
  if (incoming.id !== id) return { reject: true, status: 400, body: { error: 'id mismatch' } };

  const at = list.findIndex((x) => x.id === id);
  const stored = at === -1 ? null : list[at];

  const held = stored ? Number(stored.version) || 0 : 0;
  const sent = Number(incoming.version) || 0;
  if (stored && sent !== held) {
    return {
      reject: true,
      status: 409,
      body: {
        error: `record ${id} was changed elsewhere (you have v${sent}, the stored copy is v${held})`,
        version: held,
        record: stored,
      },
    };
  }

  // A fresh array, not a mutation of what was read: a retry re-applies this
  // change to a newer read, and mutating in place would compound the two.
  const record = { ...incoming, version: held + 1 };
  const next = at === -1 ? [...list, record] : list.map((x, i) => (i === at ? record : x));
  if (sortKey) next.sort((a, b) => String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')));

  return { value: next, status: 200, body: { saved: true, id, version: record.version, record } };
}

/**
 * Insert a batch of new records in one write, or none of them.
 *
 * The bulk import lands a whole walk at once. Fifty separate PUTs would be
 * fifty rewrites of the document and fifty chances for one to fail with the
 * batch half-saved, so the batch goes in as one change: every record is
 * checked first, and a bad one refuses the lot with its position named. New
 * records only — an id already in the log is a conflict, not an update,
 * because the import never loaded the version it would have to echo back.
 */
function insertMany({ list, batch }) {
  const seen = new Set();
  const held = new Set(list.map((x) => x.id));
  for (const [i, incoming] of batch.entries()) {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return { reject: true, status: 400, body: { error: `observation ${i} is not an object` } };
    }
    if (typeof incoming.id !== 'string' || !/^[\w-]+$/.test(incoming.id)) {
      return { reject: true, status: 400, body: { error: `observation ${i} has no usable id` } };
    }
    if (seen.has(incoming.id)) {
      return { reject: true, status: 400, body: { error: `observation ${i} repeats id ${incoming.id}` } };
    }
    if (held.has(incoming.id)) {
      return { reject: true, status: 409, body: { error: `record ${incoming.id} is already in the log` } };
    }
    seen.add(incoming.id);
  }
  const records = batch.map((incoming) => ({ ...incoming, version: 1 }));
  return { value: [...list, ...records], status: 200, body: { saved: records.length, records } };
}

// --- request parsing --------------------------------------------------------

/**
 * A query parameter as a number, or NaN when it is missing or not one.
 *
 * Read as a string first. `Number(null)` is 0, not NaN, so a request with no
 * coordinate at all would otherwise pass a finiteness check as a point in the
 * Gulf of Guinea and be answered — or sent upstream — rather than corrected.
 */
function numberParam(params, key) {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return NaN;
  return Number(raw);
}

/** The four corners of a viewport, or null when any is missing or malformed. */
function boundingBox(params) {
  const [swlat, swlng, nelat, nelng] = ['swlat', 'swlng', 'nelat', 'nelng'].map((k) => numberParam(params, k));
  if (![swlat, swlng, nelat, nelng].every(Number.isFinite)) return null;
  return { swlat, swlng, nelat, nelng };
}

// --- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // Everything the browser needs to render, in one round trip.
    if (pathname === '/api/state' && (req.method === 'GET' || req.method === 'HEAD')) {
      const [config, observations, species, glossary] = await Promise.all([
        readConfig(), readObservations(), readSpecies(), readGlossary(),
      ]);
      return json(res, 200, { config, observations, species, glossary });
    }

    // What a home-screen widget draws, chosen here rather than on the phone.
    const widgetMatch = pathname.match(/^\/api\/widget\/(\w+)$/);
    if (widgetMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const builders = { species: speciesWidget, find: findWidget, map: mapWidget };
      const build = builders[widgetMatch[1]];
      if (!build) return json(res, 404, { error: `no widget called ${widgetMatch[1]}` });
      return json(res, 200, await build());
    }

    if (pathname === '/api/config' && req.method === 'PUT') {
      const incoming = JSON.parse(await readBody(req) || '{}');
      const out = await mutate('config', {}, (current) => {
        const held = Number(current.version) || 0;
        const sent = Number(incoming.version) || 0;
        if (sent !== held) {
          return {
            reject: true, status: 409,
            body: {
              error: `config was changed elsewhere (you have v${sent}, the stored copy is v${held})`,
              version: held,
              config: current,
            },
          };
        }
        const merged = { ...current, ...incoming, version: held + 1 };
        return { value: merged, status: 200, body: { saved: true, version: merged.version } };
      });
      return json(res, out.status, out.body);
    }

    // --- photos -------------------------------------------------------------
    // Raw bytes in, an id out. The browser has already read the file to pull
    // its EXIF, so uploading the same buffer keeps what the form displayed and
    // what gets stored provably identical. multipart would buy nothing here
    // and cost a parser.
    if (pathname === '/api/photos' && req.method === 'POST') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = IMAGE_TYPES[type];
      if (!ext) return json(res, 415, { error: `unsupported image type: ${type || 'none given'}` });

      const body = await readBinaryBody(req, MAX_PHOTO_BYTES);
      if (!body.length) return json(res, 400, { error: 'empty upload' });

      const file = mintPhotoName(ext);
      // Photo names are freshly minted, so there is nothing to clobber and no
      // version token to check: the one case where last-writer-wins cannot
      // lose anything, because there is no previous writer.
      await store.writePhoto(file, body, type);
      // Keep a local copy even when the bucket is the source of truth, so the
      // photograph just taken draws without a round trip.
      if (store.kind !== 'file') await cachePhoto(file, body);
      return json(res, 201, { file, url: `photos/${file}`, bytes: body.length, mime: type });
    }

    if (pathname === '/api/glossary' && req.method === 'PUT') {
      const incoming = JSON.parse(await readBody(req) || '{}');
      if (!incoming.terms || typeof incoming.terms !== 'object') {
        return json(res, 400, { error: 'terms must be an object' });
      }
      const out = await mutate('glossary', { version: 0, terms: {} }, (current) => {
        const held = Number(current.version) || 0;
        const sent = Number(incoming.version) || 0;
        if (sent !== held) {
          return {
            reject: true, status: 409,
            body: {
              error: `glossary was changed elsewhere (you have v${sent}, the stored copy is v${held})`,
              version: held,
              glossary: current,
            },
          };
        }
        const merged = { ...current, terms: incoming.terms, version: held + 1 };
        return { value: merged, status: 200,
                 body: { saved: true, version: merged.version, glossary: merged } };
      });
      return json(res, out.status, out.body);
    }

    // --- ground elevation ----------------------------------------------------
    // Asked for one find at a time, and only for finds whose photographs
    // carried no altitude of their own.

    if (pathname === '/api/elevation' && req.method === 'GET') {
      const config = await readConfig();
      if (config.elevation?.enabled === false) return json(res, 200, { enabled: false, metres: null });

      const lat = numberParam(url.searchParams, 'lat');
      const lon = numberParam(url.searchParams, 'lon');
      const sane = Number.isFinite(lat) && Number.isFinite(lon)
        && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
      if (!sane) return json(res, 400, { error: 'a latitude and longitude are required' });

      const found = await groundElevation(lat, lon);
      // A coordinate off the model's grid is an ordinary answer, not a failure:
      // the find simply has no elevation, and the page says nothing about it.
      return json(res, 200, { enabled: true, metres: found ? found.metres : null, source: found ? found.source : null });
    }

    // --- recent rainfall -----------------------------------------------------
    // Asked for a whole viewport at once, not per find: the question it answers
    // is where to go next, and that is a question about ground you have not
    // been to yet.

    if (pathname === '/api/rain' && req.method === 'GET') {
      const config = await readConfig();
      if (config.rain?.enabled === false) return json(res, 200, { enabled: false, cells: [] });

      const box = boundingBox(url.searchParams);
      if (!box) return json(res, 400, { error: 'a bounding box is required' });
      const { swlat, swlng, nelat, nelng } = box;
      if (swlat > nelat || swlat < -90 || nelat > 90) return json(res, 400, { error: 'that bounding box is upside down' });

      // A viewport that has wrapped the date line arrives as a box wider than
      // the world. Nothing sensible can be sampled from it, and the honest
      // answer is that this is the wrong zoom to ask the question at.
      if (nelng - swlng > 180) {
        return json(res, 200, { enabled: true, cells: [], tooWide: true });
      }

      const days = Math.min(RAIN_MAX_DAYS, Math.max(1, Number(config.rain?.days) || RAIN_DEFAULT_DAYS));
      const { spacing, cells, tooWide, problem } = await recentRainfall(box, days);
      if (tooWide) return json(res, 200, { enabled: true, cells: [], tooWide: true });

      return json(res, 200, {
        enabled: true,
        days,
        spacing,
        unit: 'inch',
        // The window every cell shares, taken off the cells themselves rather
        // than computed here: Open-Meteo decides which local days those are.
        from: cells[0]?.from || null,
        to: cells[0]?.to || null,
        cells: cells.map((c) => ({ lat: c.lat, lon: c.lon, inches: c.inches })),
        problem,
      });
    }

    // --- iNaturalist ---------------------------------------------------------
    // Crowd-sourced records from other people, shown alongside your own but
    // never mixed into them: they are somebody else's identification.

    if (pathname === '/api/inat/observations' && req.method === 'GET') {
      const config = await readConfig();
      if (config.inaturalist?.enabled === false) return json(res, 200, { enabled: false, results: [] });

      const box = boundingBox(url.searchParams);
      if (!box) return json(res, 400, { error: 'a bounding box is required' });

      const query = new URLSearchParams({
        swlat: box.swlat, swlng: box.swlng, nelat: box.nelat, nelng: box.nelng,
        // Research grade only. An unvetted identification is worth less than
        // no identification when the point of looking is to check your own.
        quality_grade: 'research',
        photos: 'true',
        geo: 'true',
        order_by: 'observed_on',
        per_page: String(Math.min(200, Number(config.inaturalist?.perPage) || 80)),
      });
      const iconic = url.searchParams.get('iconic');
      if (iconic) query.set('iconic_taxa', iconic);
      const taxonId = url.searchParams.get('taxon_id');
      if (taxonId) query.set('taxon_id', taxonId);

      // A taxon that has been archived for this region is answered from disk
      // when the viewport is inside it. Asking is also what starts the
      // archive, so a species looked at on the map is one the Trends view
      // will find ready.
      const ids = taxonId ? taxonIds(taxonId) : null;
      if (ids) {
        const region = regionBox(config);
        if (contains(region, box)) {
          const served = await fromArchive(ids, box, region, Number(query.get('per_page'))).catch(() => null);
          if (served) return json(res, 200, { enabled: true, total: served.total, results: served.results, source: 'archive' });
        }
      }

      try {
        const payload = await inatGet(`/observations?${query}`);
        const results = (payload.results || []).map(slimObservation).filter(Boolean);
        return json(res, 200, { enabled: true, total: payload.total_results ?? results.length, results });
      } catch (err) {
        // A soft failure: the map still has your own pins on it.
        return json(res, 200, { enabled: true, results: [], problem: `iNaturalist unavailable: ${err.message}` });
      }
    }

    // Years of records for a taxon at once, from the archive — with the
    // ground elevation under each, which is what the Trends view sorts them
    // by. Answers at once with whatever has landed and says how far along the
    // sync is, so the chart fills in while the first fetch runs.
    if (pathname === '/api/trends' && req.method === 'GET') {
      const config = await readConfig();
      if (config.inaturalist?.enabled === false) return json(res, 200, { enabled: false, rows: [] });
      const ids = taxonIds(url.searchParams.get('taxon_id'));
      if (!ids) return json(res, 400, { error: 'taxon_id must name one or more iNaturalist taxa' });
      if (ids.length > 6) return json(res, 400, { error: 'at most 6 taxa at once' });

      const region = regionBox(config);
      const rows = [];
      const seen = new Set();
      const progress = [];
      let syncing = false;
      let syncedAt = null;
      let problem = null;
      const archives = [];
      for (const id of ids) {
        const { archive, sync } = await ensureArchive(id, region, { wantGround: true });
        archives.push(archive);
        if (sync) {
          progress.push(sync);
          if (sync.error) problem = `iNaturalist unavailable: ${sync.error}`;
          else syncing = true;
        } else if (!archive?.complete) {
          syncing = true;
        }
        if (archive?.syncedAt && (!syncedAt || archive.syncedAt < syncedAt)) syncedAt = archive.syncedAt;
      }
      // Read after the archives, which may just have pulled the ground in
      // from the bucket along with them.
      const ground = await readGround();
      for (const archive of archives) {
        for (const o of archive?.observations || []) {
          if (seen.has(o.id)) continue;
          seen.add(o.id);
          const metres = o.obscured ? null : ground[groundKey(o.lat, o.lon)];
          // Compact on purpose: a few thousand of these per species.
          rows.push([o.observedOn, Number.isFinite(metres) ? metres : null, o.acc, o.obscured ? 1 : 0]);
        }
      }
      return json(res, 200, {
        enabled: true, region, bands: bandEdges(config, Trends.DEFAULT_BANDS), since: sinceYear(config, Trends.SINCE_YEAR),
        status: syncing ? 'syncing' : 'ready', progress, problem, syncedAt, rows,
      });
    }

    // iNaturalist photographs, proxied like everything else.
    //
    // Without this the page would load images straight from their CDN, which
    // is the one hole that would let an outside host see the browser. The URL
    // comes back to us from our own /api/inat/* responses, but it arrives as a
    // string in a request, so the host is checked rather than trusted.
    if (pathname === '/api/inat/photo' && (req.method === 'GET' || req.method === 'HEAD')) {
      const raw = url.searchParams.get('url') || '';
      let target;
      try {
        target = new URL(raw);
      } catch {
        return json(res, 400, { error: 'bad photo url' });
      }
      const allowed = target.protocol === 'https:' && (
        target.hostname === 'static.inaturalist.org' ||
        target.hostname === 'inaturalist-open-data.s3.amazonaws.com'
      );
      if (!allowed) return json(res, 403, { error: 'photo host not allowed' });

      try {
        const upstreamRes = await upstream(target.href, { accept: 'image/*' });
        const body = Buffer.from(await upstreamRes.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': upstreamRes.headers.get('content-type') || 'image/jpeg',
          'Content-Length': body.length,
          'Cache-Control': 'public, max-age=86400',
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      } catch (err) {
        return json(res, 502, { error: `photo unavailable: ${err.message}` });
      }
    }

    if (pathname === '/api/inat/taxa' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json(res, 400, { error: 'a search term is required' });
      const query = new URLSearchParams({ q, per_page: '8', is_active: 'true' });
      const iconic = url.searchParams.get('iconic');
      if (iconic) query.set('iconic_taxa', iconic);
      try {
        const payload = await inatGet(`/taxa?${query}`);
        return json(res, 200, { results: (payload.results || []).map(slimTaxon) });
      } catch (err) {
        return json(res, 200, { results: [], problem: `iNaturalist unavailable: ${err.message}` });
      }
    }

    // Many new finds at once, from the bulk import. See insertMany.
    if (pathname === '/api/observations' && req.method === 'POST') {
      const incoming = JSON.parse(await readBody(req) || '{}');
      const batch = incoming.observations;
      if (!Array.isArray(batch) || !batch.length) {
        return json(res, 400, { error: 'observations must be a non-empty array' });
      }
      if (batch.length > MAX_BATCH) {
        return json(res, 400, { error: `at most ${MAX_BATCH} observations per import` });
      }
      const out = await mutate('observations', [], (list) => insertMany({ list, batch }));
      if (out.status === 200) pruneOrphanPhotos();
      return json(res, out.status, out.body);
    }

    const observationMatch = pathname.match(/^\/api\/observations\/([\w-]+)$/);
    if (observationMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = observationMatch[1];

      if (req.method === 'DELETE') {
        const out = await mutate('observations', [], (list) => {
          const next = list.filter((x) => x.id !== id);
          if (next.length === list.length) {
            return { reject: true, status: 404, body: { error: 'Not found' } };
          }
          return { value: next, status: 200, body: { deleted: true, id } };
        });
        if (out.status === 200) pruneOrphanPhotos();
        return json(res, out.status, out.body);
      }

      const incoming = JSON.parse(await readBody(req) || '{}');
      const out = await mutate('observations', [],
        (list) => upsert({ list, id, incoming }));
      if (out.status === 200) pruneOrphanPhotos();
      return json(res, out.status, out.body);
    }

    const speciesMatch = pathname.match(/^\/api\/species\/([\w-]+)$/);
    if (speciesMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = speciesMatch[1];

      if (req.method === 'DELETE') {
        // Observations keep pointing at a deleted species by id; the model
        // reads a dangling pointer as unidentified. Clearing them here would
        // be a second write that can fail on its own, leaving the two
        // documents disagreeing — and it would silently destroy the
        // identification rather than letting it be re-linked.
        const observations = await readObservations();
        const orphaned = observations.filter((o) => o.speciesId === id).length;

        const out = await mutate('species', [], (list) => {
          const next = list.filter((x) => x.id !== id);
          if (next.length === list.length) {
            return { reject: true, status: 404, body: { error: 'Not found' } };
          }
          return { value: next, status: 200, body: { deleted: true, id, orphaned } };
        });
        if (out.status === 200) pruneOrphanPhotos();
        return json(res, out.status, out.body);
      }

      const incoming = JSON.parse(await readBody(req) || '{}');
      const result = await mutate('species', [],
        (list) => upsert({ list, id, incoming, sortKey: 'commonName' }));
      if (result.status === 200) pruneOrphanPhotos();
      return json(res, result.status, result.body);
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Method not allowed' });
    }

    // Map tiles, cached to disk on the way through.
    const tileMatch = pathname.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tileMatch) {
      const coords = parseTileCoords(tileMatch[1], tileMatch[2], tileMatch[3]);
      if (!coords) return json(res, 400, { error: 'bad tile coordinates' });
      const config = await readConfig();
      const template = config.map?.tileUrl;
      if (!template) return json(res, 404, { error: 'no tile source configured' });
      return serveTile(res, coords, template);
    }

    // Stored photos. Served only by a name matching the minted shape, so the
    // request string never composes a path of its own choosing.
    if (pathname.startsWith('/photos/')) {
      const name = pathname.slice('/photos/'.length);
      if (!PHOTO_NAME.test(name)) return json(res, 404, { error: 'Not found' });
      const data = await loadPhoto(name);
      if (!data) return json(res, 404, { error: 'Not found' });
      return send(res, 200, {
        'Content-Type': PHOTO_MIME[path.extname(name)] || 'application/octet-stream',
        // An id is minted per upload and never rewritten, so the bytes behind
        // one of these URLs can never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
      }, data);
    }

    const rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

    // The app has no build step, so its files carry no version in their
    // names and cannot be cached blind the way photos are. Instead the phone
    // asks every time and is told "unchanged" — a 304 with no body — unless
    // the file really did change, in which case the edit is on screen at the
    // next reload rather than after some cache expires.
    const data = await fsp.readFile(filePath);
    return send(res, 200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etagFor(data),
    }, data);
  } catch (err) {
    if (err.code === 'ENOENT') return json(res, 404, { error: 'Not found' });
    if (err.tooLarge) return json(res, 413, { error: err.message });
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

function json(res, status, payload) {
  send(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, JSON.stringify(payload));
}

// --- sending ----------------------------------------------------------------
// Every body leaves through send(), which is where two things the phone cares
// about happen: the body is gzipped when the browser can take it, and a file
// the browser already holds is answered with a 304 rather than sent again.

// Text and JSON shrink four or five times over the wire. Images are already
// compressed and only get bigger.
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg\+xml)/;
// Below this the gzip header costs more than it saves.
const GZIP_MIN_BYTES = 1024;

/**
 * Send a body with the headers given, gzipped when the client accepts it and
 * the type is worth it. A response carrying an ETag becomes a 304 when the
 * client's If-None-Match names that tag. HEAD gets the headers and no body.
 *
 * The request is taken from res.req rather than passed, so the many json()
 * call sites need not change.
 */
function send(res, status, headers, body) {
  const req = res.req;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const out = { ...headers };
  const compressible = COMPRESSIBLE.test(out['Content-Type'] || '');
  if (compressible) out.Vary = 'Accept-Encoding';

  if (out.ETag && status === 200 && etagMatches(req.headers['if-none-match'], out.ETag)) {
    // Only the headers a cache needs to keep what it has fresh.
    res.writeHead(304, {
      ETag: out.ETag,
      ...(out['Cache-Control'] ? { 'Cache-Control': out['Cache-Control'] } : {}),
      ...(out.Vary ? { Vary: out.Vary } : {}),
    });
    return res.end();
  }

  const gzip = compressible && buf.length >= GZIP_MIN_BYTES && acceptsGzip(req);
  const data = gzip ? zlib.gzipSync(buf, { level: 6 }) : buf;
  if (gzip) out['Content-Encoding'] = 'gzip';
  out['Content-Length'] = data.length;
  res.writeHead(status, out);
  return res.end(req.method === 'HEAD' ? undefined : data);
}

/** Whether the request's Accept-Encoding admits gzip. */
function acceptsGzip(req) {
  const header = req.headers['accept-encoding'] || '';
  return header.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';');
    if (name.trim() !== 'gzip' && name.trim() !== '*') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
}

/**
 * A validator for a body. Weak, because the same bytes go out both plain and
 * gzipped and a weak tag is allowed to name both; a strong one would have to
 * differ per encoding.
 */
function etagFor(data) {
  return `W/"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 20)}"`;
}

/** Whether an If-None-Match header names this tag. Weak comparison, per RFC 9110. */
function etagMatches(header, tag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => bare(candidate) === bare(tag));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    // Decoded by the stream, so a multi-byte character split across two
    // chunks arrives whole rather than as two replacement characters.
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) reject(tooLarge('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Checked as it streams rather than after: the point is to not hold a
      // 200MB video in memory before deciding to refuse it.
      if (size > limit) {
        reject(tooLarge(`Photo larger than ${Math.round(limit / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tooLarge(message) {
  const err = new Error(message);
  err.tooLarge = true;
  return err;
}

/**
 * A store with no config in it gets the example data, so a fresh checkout — or
 * a brand new bucket — opens on something to look at rather than an empty
 * page. It is a made-up handful of finds in a made-up wood, not anybody's log.
 *
 * Only the four documents are seeded. The example species carry no
 * photographs: shipping image files in the repo to illustrate an empty state
 * is a poor trade, and the app reads an empty photos array perfectly well.
 */
async function seedIfEmpty() {
  const { value } = await store.read('config');
  if (value !== undefined) return false;

  const examples = path.join(ROOT, 'example');
  for (const [key, rel] of Object.entries(STORE_KEYS)) {
    let raw;
    try {
      raw = await fsp.readFile(path.join(examples, rel), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      await store.write(key, key === 'observations' ? rebase(parsed) : parsed, null);
    } catch (err) {
      // Another instance seeded it a moment ago. Theirs is as good as ours.
      if (!(err instanceof StoreConflict)) throw err;
    }
  }
  return true;
}

/**
 * The example finds carry fixed dates. Shift them so the newest one landed a
 * few days ago, keeping the gaps between them intact.
 *
 * An example that opens reading "last find: two years ago" teaches a new
 * setup nothing about what the app is for, and the map and the season readout
 * both key off recency. The spacing is what carries the meaning — two finds on
 * one walk, a nettle in spring — so every date moves by the same amount.
 */
function rebase(observations) {
  const stamps = observations.map((o) => Date.parse(o.observedAt)).filter(Number.isFinite);
  if (!stamps.length) return observations;
  const shift = Date.now() - 5 * 86400000 - Math.max(...stamps);
  return observations.map((o) => {
    const at = Date.parse(o.observedAt);
    if (!Number.isFinite(at)) return o;
    // Local wall time with no zone, which is how the rest of the log stores it.
    const moved = new Date(at + shift);
    const pad = (n) => String(n).padStart(2, '0');
    return { ...o, observedAt: `${moved.getFullYear()}-${pad(moved.getMonth() + 1)}-${pad(moved.getDate())}`
      + `T${pad(moved.getHours())}:${pad(moved.getMinutes())}` };
  });
}

/** Every non-internal IPv4 address, so the reachable URLs can be printed. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

(async () => {
  let seeded;
  try {
    seeded = await seedIfEmpty();
  } catch (err) {
    console.error(`Could not reach the store at ${store.describe()}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  server.listen(PORT, HOST, () => {
    console.log(`Field Notes → http://127.0.0.1:${PORT}`);
    if (HOST !== '127.0.0.1') {
      for (const address of lanAddresses()) console.log(`        → http://${address}:${PORT}`);
      console.log('Reachable from other devices on this network. No login — set HOST=127.0.0.1 to restrict.');
    }
    console.log(`State:  ${store.describe()}${store.kind === 's3' ? '' : ' (local files)'}`);
    const shownPhotoDir = PHOTO_DIR.startsWith(process.cwd())
      ? path.relative(process.cwd(), PHOTO_DIR) : PHOTO_DIR;
    console.log(`Photos: ${shownPhotoDir}${store.kind === 's3' ? ' (cache; the bucket holds them)' : ''}`);
    if (seeded) console.log('        seeded from example/ — this is made-up data, not yours.');
  });
})();
