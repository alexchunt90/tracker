'use strict';

/* ---------------------------------------------------------------------------
 * The geometry behind the rainfall layer: which coordinates get sampled for a
 * given viewport.
 *
 * Separated from the server because it is the part that decides whether the
 * map tells the truth. Everything else in the feature is fetching and caching,
 * which fails loudly; this fails quietly — a lattice that covers less than the
 * screen paints "no rain" over ground nobody asked about, and looks exactly
 * like a correct answer. It is worth being able to test on its own.
 * ------------------------------------------------------------------------- */

/*
 * Samples are snapped to a fixed global lattice rather than to the viewport.
 *
 * Panning produces a different bounding box every few pixels, and a cache keyed
 * on the box would miss on every one of them. Snapped, the same ground answers
 * with the same coordinates however you arrived at it, so a pan mostly re-reads
 * cells that are already on disk and asks upstream only about the strip that
 * just came into view.
 *
 * Each spacing is twice the one below it, which makes the coarse lattices
 * strict subsets of the fine ones — zooming out re-uses every other cell it
 * already had instead of starting again on an unrelated grid.
 */
const RAIN_SPACINGS = [0.05, 0.1, 0.2, 0.4, 0.8];

/*
 * Enough cells to read as a field rather than as dots, few enough that a pan
 * cannot ask Open-Meteo for thousands of points. The finest spacing that fits
 * under this wins, so zooming in buys detail rather than a longer wait.
 *
 * Sized off the view this is actually for. Three hundred was the first guess
 * and it cut off at the wrong place: a wide regional view — Vancouver Island
 * across to Montana, which is a plausible "where shall we drive this weekend"
 * — came to 306 cells and was refused, while the continental view it was meant
 * to refuse is several thousand and still is. Six hundred covers the whole
 * west at the coarsest spacing and costs six batched requests, most of them
 * usually served off disk.
 */
const RAIN_MAX_CELLS = 600;

// Coordinates are snapped before they are used, so this is only guarding
// against float noise — 0.05 × 941 is 47.050000000000004.
const RAIN_PRECISION = 4;

const snap = (value, spacing) => Number((Math.round(value / spacing) * spacing).toFixed(RAIN_PRECISION));

/**
 * The finest lattice that covers this box in under `cap` points, or null when
 * even the coarsest one overflows.
 *
 * Null is the important return. The first version fell back to the coarsest
 * spacing and sampled it anyway, which meant a continental viewport filled its
 * point budget on a band across the bottom of the screen and returned dry
 * everywhere else — ground that had never been asked about, drawn exactly like
 * ground that had been asked about and was dry. A map that cannot cover what
 * is on screen has to say so instead of shading part of it.
 */
function rainSpacing(box, cap = RAIN_MAX_CELLS) {
  for (const spacing of RAIN_SPACINGS) {
    const rows = Math.floor((box.nelat - box.swlat) / spacing) + 2;
    const cols = Math.floor((box.nelng - box.swlng) / spacing) + 2;
    if (rows * cols <= cap) return spacing;
  }
  return null;
}

/** Every lattice point inside a box, at a given spacing. */
function latticePoints(box, spacing) {
  const points = [];
  const startLat = snap(box.swlat, spacing), endLat = snap(box.nelat, spacing);
  const startLon = snap(box.swlng, spacing), endLon = snap(box.nelng, spacing);
  for (let lat = startLat; lat <= endLat + 1e-9; lat = Number((lat + spacing).toFixed(RAIN_PRECISION))) {
    for (let lon = startLon; lon <= endLon + 1e-9; lon = Number((lon + spacing).toFixed(RAIN_PRECISION))) {
      if (lat < -90 || lat > 90) continue;
      points.push({ lat, lon });
      // rainSpacing has already sized the grid, so this is a guard against a
      // lattice mis-stepped by a float rather than an expected exit. Coming out
      // here would truncate the map, so it stays well clear of the real budget.
      if (points.length >= RAIN_MAX_CELLS * 4) return points;
    }
  }
  return points;
}

const rainKey = (lat, lon) => `${lat.toFixed(RAIN_PRECISION)}_${lon.toFixed(RAIN_PRECISION)}`;

module.exports = { RAIN_SPACINGS, RAIN_MAX_CELLS, RAIN_PRECISION, snap, rainSpacing, latticePoints, rainKey };
