'use strict';

/* ---------------------------------------------------------------------------
 * Tracker — a local, single-user journal. First view: a nature log.
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
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ENV_PATH = path.join(ROOT, '.env');

// --- .env -------------------------------------------------------------------
// A missing .env is fine; the real environment always wins.

function loadEnv(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnv(ENV_PATH);

// Writable state. Defaults to the project directory, which is the layout when
// running from a checkout. Point STATE_DIR at a mounted volume to containerise
// — and note it must be a *directory*: saves write a temp file and rename over
// the target, which fails against a bind-mounted file.
const STATE_DIR = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : ROOT;
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const DATA_DIR = path.join(STATE_DIR, 'data');
const OBSERVATIONS_PATH = path.join(DATA_DIR, 'observations.json');
const SPECIES_PATH = path.join(DATA_DIR, 'species.json');
const PHOTO_DIR = path.join(STATE_DIR, 'photos');
const TILE_DIR = path.join(STATE_DIR, 'tiles');

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
  '.ico': 'image/x-icon',
};

// What may be uploaded, and what each type is stored as. The extension comes
// from this table rather than from the client's filename: a name is attacker
// controlled, and it is the only thing that decides how the file is served
// back later.
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
};
const PHOTO_MIME = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([m, e]) => [e, m]));

// Phone photos run large, and a HEIC burst frame larger still.
const MAX_PHOTO_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// A photo uploaded from a form that was never submitted has nothing pointing at
// it, and would be pruned the moment anything else saved. This is the grace
// period before an unreferenced file is considered abandoned.
const ORPHAN_GRACE_MS = 6 * 60 * 60 * 1000;

// Outside services are asked to identify the caller, and iNaturalist's terms
// ask for a contact address in the agent string.
const USER_AGENT = process.env.TRACKER_USER_AGENT || 'Tracker/1.0 (personal nature log; https://github.com/)';

// Upstream calls must not hang a page load. Both services are fast when they
// are up and unreachable when they are not; there is no useful middle.
const UPSTREAM_TIMEOUT_MS = 9000;

// --- storage ----------------------------------------------------------------

/**
 * Write via a sibling temp file and rename. On one filesystem the rename is
 * atomic, so an interrupted save leaves the previous file intact rather than a
 * truncated one. A half-written log is not recoverable by hand.
 */
async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

const readConfig = () => readJson(CONFIG_PATH);
const readObservations = () => readJson(OBSERVATIONS_PATH, []);
const readSpecies = () => readJson(SPECIES_PATH, []);

// --- photos -----------------------------------------------------------------

// Serving a stored file is the one place a request string reaches the
// filesystem, so the name is required to be exactly what we mint: hex plus a
// known extension. Nothing else is even looked up, which makes traversal and
// symlink tricks unrepresentable rather than merely filtered.
const PHOTO_NAME = /^[0-9a-f]{16}\.(jpg|png|webp|gif|heic|heif|avif|tiff)$/;

const mintPhotoName = (ext) => crypto.randomBytes(8).toString('hex') + ext;

/** Every photo filename referenced by any saved record. */
function referencedPhotos(observations, species) {
  const set = new Set();
  const add = (photos) => {
    for (const p of photos || []) {
      if (p?.file) set.add(p.file);
      if (p?.thumb) set.add(p.thumb);
    }
  };
  for (const o of observations || []) add(o.photos);
  for (const s of species || []) add(s.photos);
  return set;
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
    const files = await fsp.readdir(PHOTO_DIR).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const now = Date.now();
    for (const file of files) {
      if (!PHOTO_NAME.test(file) || keep.has(file)) continue;
      const full = path.join(PHOTO_DIR, file);
      const stat = await fsp.stat(full).catch(() => null);
      // Young and unreferenced means "sitting in a form that has not been
      // submitted yet", not "abandoned".
      if (!stat || now - stat.mtimeMs < ORPHAN_GRACE_MS) continue;
      await fsp.unlink(full).catch(() => {});
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
async function upstream(url, { accept } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept || 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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

/** Rewrite an upstream image URL to go back through this server. */
const proxiedPhoto = (url) => (url ? `api/inat/photo?url=${encodeURIComponent(url)}` : null);

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

// --- collections ------------------------------------------------------------

/**
 * Upsert one record into a JSON array file, with the same optimistic
 * concurrency finances uses: the client echoes the version it loaded, and a
 * mismatch means another tab or another device wrote first. Rejecting is the
 * only safe answer — the alternative is silently discarding their edit.
 */
async function upsert({ file, list, id, incoming, sortKey }) {
  if (incoming.id !== id) return { status: 400, body: { error: 'id mismatch' } };

  const at = list.findIndex((x) => x.id === id);
  const stored = at === -1 ? null : list[at];

  const held = stored ? Number(stored.version) || 0 : 0;
  const sent = Number(incoming.version) || 0;
  if (stored && sent !== held) {
    return {
      status: 409,
      body: {
        error: `record ${id} was changed elsewhere (you have v${sent}, the file is v${held})`,
        version: held,
        record: stored,
      },
    };
  }

  const record = { ...incoming, version: held + 1 };
  if (at === -1) list.push(record); else list[at] = record;
  if (sortKey) list.sort((a, b) => String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')));

  await writeJsonAtomic(file, list);
  return { status: 200, body: { saved: true, id, version: record.version, record } };
}

// --- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // Everything the browser needs to render, in one round trip.
    if (pathname === '/api/state' && (req.method === 'GET' || req.method === 'HEAD')) {
      const [config, observations, species] = await Promise.all([
        readConfig(), readObservations(), readSpecies(),
      ]);
      return json(res, 200, { config, observations, species });
    }

    if (pathname === '/api/config' && req.method === 'PUT') {
      const incoming = JSON.parse(await readBody(req) || '{}');
      const current = await readConfig();
      const held = Number(current.version) || 0;
      const sent = Number(incoming.version) || 0;
      if (sent !== held) {
        return json(res, 409, {
          error: `config was changed elsewhere (you have v${sent}, the file is v${held})`,
          version: held,
          config: current,
        });
      }
      const merged = { ...current, ...incoming, version: held + 1 };
      await writeJsonAtomic(CONFIG_PATH, merged);
      return json(res, 200, { saved: true, version: merged.version });
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
      await fsp.mkdir(PHOTO_DIR, { recursive: true });
      // Photo names are freshly minted, so there is no existing file to clobber
      // and no temp-and-rename dance needed.
      await fsp.writeFile(path.join(PHOTO_DIR, file), body);
      return json(res, 201, { file, url: `photos/${file}`, bytes: body.length, mime: type });
    }

    // --- iNaturalist ---------------------------------------------------------
    // Crowd-sourced records from other people, shown alongside your own but
    // never mixed into them: they are somebody else's identification.

    if (pathname === '/api/inat/observations' && req.method === 'GET') {
      const config = await readConfig();
      if (config.inaturalist?.enabled === false) return json(res, 200, { enabled: false, results: [] });

      const box = ['swlat', 'swlng', 'nelat', 'nelng'].map((k) => Number(url.searchParams.get(k)));
      if (!box.every(Number.isFinite)) return json(res, 400, { error: 'a bounding box is required' });

      const query = new URLSearchParams({
        swlat: box[0], swlng: box[1], nelat: box[2], nelng: box[3],
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

      try {
        const payload = await inatGet(`/observations?${query}`);
        const results = (payload.results || []).map(slimObservation).filter(Boolean);
        return json(res, 200, { enabled: true, total: payload.total_results ?? results.length, results });
      } catch (err) {
        // A soft failure: the map still has your own pins on it.
        return json(res, 200, { enabled: true, results: [], problem: `iNaturalist unavailable: ${err.message}` });
      }
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

    const observationMatch = pathname.match(/^\/api\/observations\/([\w-]+)$/);
    if (observationMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = observationMatch[1];
      const list = await readObservations();

      if (req.method === 'DELETE') {
        const next = list.filter((x) => x.id !== id);
        if (next.length === list.length) return json(res, 404, { error: 'Not found' });
        await writeJsonAtomic(OBSERVATIONS_PATH, next);
        pruneOrphanPhotos();
        return json(res, 200, { deleted: true, id });
      }

      const incoming = JSON.parse(await readBody(req) || '{}');
      const result = await upsert({ file: OBSERVATIONS_PATH, list, id, incoming });
      if (result.status === 200) pruneOrphanPhotos();
      return json(res, result.status, result.body);
    }

    const speciesMatch = pathname.match(/^\/api\/species\/([\w-]+)$/);
    if (speciesMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = speciesMatch[1];
      const list = await readSpecies();

      if (req.method === 'DELETE') {
        const next = list.filter((x) => x.id !== id);
        if (next.length === list.length) return json(res, 404, { error: 'Not found' });

        // Observations keep pointing at a deleted species by id; the model
        // reads a dangling pointer as unidentified. Clearing them here would
        // be a second write that can fail on its own, leaving the two files
        // disagreeing — and it would silently destroy the identification
        // rather than letting it be re-linked.
        const observations = await readObservations();
        const orphaned = observations.filter((o) => o.speciesId === id).length;

        await writeJsonAtomic(SPECIES_PATH, next);
        pruneOrphanPhotos();
        return json(res, 200, { deleted: true, id, orphaned });
      }

      const incoming = JSON.parse(await readBody(req) || '{}');
      const result = await upsert({ file: SPECIES_PATH, list, id, incoming, sortKey: 'commonName' });
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
      const data = await fsp.readFile(path.join(PHOTO_DIR, name));
      res.writeHead(200, {
        'Content-Type': PHOTO_MIME[path.extname(name)] || 'application/octet-stream',
        'Content-Length': data.length,
        // An id is minted per upload and never rewritten, so the bytes behind
        // one of these URLs can never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }

    const rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    if (err.code === 'ENOENT') return json(res, 404, { error: 'Not found' });
    if (err.tooLarge) return json(res, 413, { error: err.message });
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
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

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`config.json not found at ${CONFIG_PATH}`);
  process.exit(1);
}

/** Every non-internal IPv4 address, so the reachable URLs can be printed. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

server.listen(PORT, HOST, () => {
  console.log(`Tracker → http://127.0.0.1:${PORT}`);
  if (HOST !== '127.0.0.1') {
    for (const address of lanAddresses()) console.log(`        → http://${address}:${PORT}`);
    console.log('Reachable from other devices on this network. No login — set HOST=127.0.0.1 to restrict.');
  }
  console.log(`Log:    ${path.relative(process.cwd(), OBSERVATIONS_PATH)}`);
  console.log(`Photos: ${path.relative(process.cwd(), PHOTO_DIR)}`);
});
