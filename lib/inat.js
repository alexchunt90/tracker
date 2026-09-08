'use strict';

/* ---------------------------------------------------------------------------
 * The policy behind the iNaturalist archive: which region it covers, when a
 * copy is old, and whether a map's viewport can be answered from it.
 *
 * The fetching lives in server.js. This is the part worth testing without a
 * network: a region that quietly failed to cover the map would answer a pan
 * with an empty box that looked exactly like nobody having found anything.
 * ------------------------------------------------------------------------- */

// How far around the map's home the archive reaches, in degrees. The default
// is sized for a mountain range rather than a county: the whole point of the
// altitude cohorts is comparing the coast with the passes, and those are a
// few degrees apart. Config can name an explicit box instead.
const REGION_SPAN_LAT = 2.5;
const REGION_SPAN_LON = 3.5;

// A day, and a month. The first is how often new records are asked for; the
// second is how often the whole thing is thrown away and fetched again, which
// is what catches records that were deleted, re-identified, or promoted to
// research grade after they were first seen.
const INAT_TOPUP_MS = 24 * 60 * 60 * 1000;
const INAT_RESYNC_MS = 30 * 24 * 60 * 60 * 1000;

// Ground elevations for the archive are keyed on a coordinate rounded to
// three decimal places — about a hundred metres — rather than the four the
// finds use. A record's own accuracy is rarely better than that, and the
// terrain model behind Open-Meteo is ninety metres a cell; finer would only
// mean asking the same cell twice under two names.
const GROUND_PRECISION = 3;

const groundKey = (lat, lon) => `${lat.toFixed(GROUND_PRECISION)}_${lon.toFixed(GROUND_PRECISION)}`;

/** A bounding box as the four numbers the rest of the app passes around, or null. */
function cleanBox(box) {
  if (!box) return null;
  const out = {};
  for (const k of ['swlat', 'swlng', 'nelat', 'nelng']) {
    const n = Number(box[k]);
    if (!Number.isFinite(n)) return null;
    out[k] = n;
  }
  if (out.swlat >= out.nelat || out.swlng >= out.nelng) return null;
  if (out.swlat < -90 || out.nelat > 90 || out.swlng < -180 || out.nelng > 180) return null;
  return out;
}

/**
 * The region the archive covers, from config. An explicit `trends.region`
 * wins; otherwise a box around the map's home coordinate.
 */
function regionBox(config) {
  const named = cleanBox(config?.trends?.region);
  if (named) return named;
  const home = config?.map?.default || {};
  const lat = Number.isFinite(Number(home.lat)) ? Number(home.lat) : 47.62;
  const lon = Number.isFinite(Number(home.lon)) ? Number(home.lon) : -122.33;
  const r = (n) => Number(n.toFixed(4));
  return {
    swlat: r(Math.max(-90, lat - REGION_SPAN_LAT)), nelat: r(Math.min(90, lat + REGION_SPAN_LAT)),
    swlng: r(Math.max(-180, lon - REGION_SPAN_LON)), nelng: r(Math.min(180, lon + REGION_SPAN_LON)),
  };
}

/** The cohort edges from config, or the default when it names none. */
function bandEdges(config, fallback) {
  const raw = config?.trends?.bands;
  if (!Array.isArray(raw)) return fallback;
  const clean = raw.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return clean.length ? clean : fallback;
}

/** The first year the Trends view shows, from config, or the fallback. */
function sinceYear(config, fallback) {
  const n = Number(config?.trends?.since);
  return Number.isInteger(n) && n > 1900 && n < 3000 ? n : fallback;
}

/** Whether one box lies entirely inside another. */
function contains(outer, inner) {
  if (!outer || !inner) return false;
  return inner.swlat >= outer.swlat && inner.nelat <= outer.nelat
    && inner.swlng >= outer.swlng && inner.nelng <= outer.nelng;
}

/** Whether a point lies inside a box. */
const inside = (box, lat, lon) =>
  lat >= box.swlat && lat <= box.nelat && lon >= box.swlng && lon <= box.nelng;

const sameBox = (a, b) => !!a && !!b && ['swlat', 'swlng', 'nelat', 'nelng'].every((k) => a[k] === b[k]);

/**
 * What an archive on disk needs, given what it is and when it is: nothing,
 * a top-up of records newer than the last, or a fresh start.
 *
 * A copy made for a different region is a fresh start however new it is; a
 * copy that never finished is resumed, which is a top-up from wherever it
 * stopped, because every page that landed was written down before the next
 * was asked for.
 */
function archiveNeed(archive, region, now = Date.now()) {
  if (!archive || !sameBox(archive.region, region)) return 'full';
  const at = Date.parse(archive.startedAt || archive.syncedAt || '');
  if (!Number.isFinite(at) || now - at >= INAT_RESYNC_MS) return 'full';
  if (!archive.complete) return 'topup';
  const synced = Date.parse(archive.syncedAt || '');
  if (!Number.isFinite(synced) || now - synced >= INAT_TOPUP_MS) return 'topup';
  return 'none';
}

/** Taxon ids out of a `1,2,3` query string, or null when any is not one. */
function taxonIds(raw) {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const ids = [];
  for (const p of parts) {
    if (!/^\d{1,9}$/.test(p)) return null;
    const n = Number(p);
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}

module.exports = {
  REGION_SPAN_LAT, REGION_SPAN_LON, INAT_TOPUP_MS, INAT_RESYNC_MS, GROUND_PRECISION,
  groundKey, cleanBox, regionBox, bandEdges, sinceYear, contains, inside, sameBox, archiveNeed, taxonIds,
};
