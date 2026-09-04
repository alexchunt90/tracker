/*
 * The rainfall lattice: which coordinates a viewport gets sampled at.
 *
 * This exists because the failure mode is silent. Every other part of the rain
 * layer fails in a way you can see — a dead upstream draws nothing, a bad
 * bounding box gets a 400 — but a lattice that covers less than the screen
 * draws a perfectly ordinary-looking map with "no rain" over ground that was
 * never sampled. That shipped once, in the first version, and the only reason
 * it was caught was zooming out over a map that had no business being dry.
 *
 *   node test/rain.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const { RAIN_SPACINGS, RAIN_MAX_CELLS, rainSpacing, latticePoints, snap, rainKey } = require('../lib/rain.js');

/** Boxes named for what they are, because the numbers alone say nothing. */
const A_VALLEY   = { swlat: 47.60, swlng: -121.80, nelat: 47.85, nelng: -121.40 };
const A_METRO    = { swlat: 47.20, swlng: -122.60, nelat: 48.10, nelng: -121.40 };
const A_REGION   = { swlat: 44.58, swlng: -135.20, nelat: 50.75, nelng: -109.10 };
const A_CONTINENT = { swlat: 25.00, swlng: -125.00, nelat: 49.00, nelng: -67.00 };

test('the spacing ladder never gets finer as the viewport grows', () => {
  const ladder = [A_VALLEY, A_METRO, A_REGION].map((box) => rainSpacing(box));
  for (const spacing of ladder) assert.ok(RAIN_SPACINGS.includes(spacing), `${spacing} is not a rung`);
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i] >= ladder[i - 1], `${ladder[i]} is finer than ${ladder[i - 1]} on a larger box`);
  }
  // Two boxes far enough apart in scale that they cannot share a rung, so the
  // ladder is doing something rather than answering 0.05 to everything.
  assert.ok(rainSpacing(A_REGION) > rainSpacing(A_VALLEY),
    'a region and a valley should not sample at the same spacing');
});

test('a viewport too wide to cover is refused rather than part-sampled', () => {
  assert.strictEqual(rainSpacing(A_CONTINENT), null);
});

/*
 * The regression, stated as the invariant rather than as the old bug: an
 * accepted viewport is covered corner to corner. What shipped once was a
 * lattice that ran out of budget partway up the screen and returned dry for
 * everything above it, which is indistinguishable on the map from ground that
 * was checked and found dry.
 */
test('an accepted viewport is sampled corner to corner', () => {
  for (const box of [A_VALLEY, A_METRO, A_REGION]) {
    const spacing = rainSpacing(box);
    assert.ok(spacing !== null, `${JSON.stringify(box)} should be sampleable`);
    const points = latticePoints(box, spacing);
    const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);

    // Within half a cell of each edge: snapping rounds to nearest, so the
    // outermost sample may sit just inside or just outside the boundary.
    assert.ok(Math.min(...lats) <= box.swlat + spacing, 'the south edge is not covered');
    assert.ok(Math.max(...lats) >= box.nelat - spacing, 'the north edge is not covered');
    assert.ok(Math.min(...lons) <= box.swlng + spacing, 'the west edge is not covered');
    assert.ok(Math.max(...lons) >= box.nelng - spacing, 'the east edge is not covered');

    // Every row present, not just the ones the budget reached.
    const rows = new Set(lats).size;
    assert.ok(rows >= Math.floor((box.nelat - box.swlat) / spacing) + 1,
      `only ${rows} rows for a box ${(box.nelat - box.swlat).toFixed(2)}° tall at ${spacing}`);
  }
});

test('every lattice point sits inside the box it was asked for', () => {
  for (const box of [A_VALLEY, A_METRO, A_REGION]) {
    const spacing = rainSpacing(box);
    for (const p of latticePoints(box, spacing)) {
      // Snapping rounds to nearest, so an edge point may sit half a cell out.
      assert.ok(p.lat >= box.swlat - spacing && p.lat <= box.nelat + spacing, `lat ${p.lat} outside ${JSON.stringify(box)}`);
      assert.ok(p.lon >= box.swlng - spacing && p.lon <= box.nelng + spacing, `lon ${p.lon} outside ${JSON.stringify(box)}`);
    }
  }
});

test('a lattice stays inside the cell budget', () => {
  for (const box of [A_VALLEY, A_METRO, A_REGION]) {
    const spacing = rainSpacing(box);
    assert.ok(latticePoints(box, spacing).length <= RAIN_MAX_CELLS,
      `${JSON.stringify(box)} at ${spacing} overflows the budget`);
  }
});

/*
 * What makes the cache worth having: the same ground has to answer with the
 * same coordinates however you panned to it, or every pan is a full miss.
 */
test('the lattice is fixed to the world, not to the viewport', () => {
  const spacing = 0.1;
  const west = latticePoints({ swlat: 47.3, swlng: -122.5, nelat: 47.7, nelng: -122.0 }, spacing);
  const east = latticePoints({ swlat: 47.3, swlng: -122.2, nelat: 47.7, nelng: -121.7 }, spacing);
  const overlap = new Set(west.map((p) => rainKey(p.lat, p.lon)));
  const shared = east.filter((p) => overlap.has(rainKey(p.lat, p.lon)));
  assert.ok(shared.length > 0, 'two overlapping viewports must share the cells they overlap on');
});

/*
 * Coarse lattices are strict subsets of fine ones, so zooming out re-uses
 * every other cell rather than starting again on an unrelated grid.
 */
test('coarse lattices nest inside fine ones', () => {
  for (let i = 1; i < RAIN_SPACINGS.length; i++) {
    const fine = RAIN_SPACINGS[i - 1], coarse = RAIN_SPACINGS[i];
    assert.ok(Math.abs(coarse / fine - Math.round(coarse / fine)) < 1e-9,
      `${coarse} is not a whole multiple of ${fine}`);
  }
  const box = { swlat: 47.0, swlng: -122.0, nelat: 47.8, nelng: -121.2 };
  const fine = new Set(latticePoints(box, 0.1).map((p) => rainKey(p.lat, p.lon)));
  for (const p of latticePoints(box, 0.2)) {
    assert.ok(fine.has(rainKey(p.lat, p.lon)), `${rainKey(p.lat, p.lon)} is not on the finer lattice`);
  }
});

test('snapping survives float arithmetic', () => {
  assert.strictEqual(snap(47.0499, 0.05), 47.05);
  assert.strictEqual(snap(-122.34, 0.1), -122.3);
  // The case that motivated rounding at all: 0.05 × 941 is 47.050000000000004.
  for (const p of latticePoints({ swlat: 47.0, swlng: -122.0, nelat: 47.5, nelng: -121.5 }, 0.05)) {
    assert.strictEqual(p.lat, Number(p.lat.toFixed(4)), `${p.lat} carries float noise`);
    assert.strictEqual(p.lon, Number(p.lon.toFixed(4)), `${p.lon} carries float noise`);
  }
});
