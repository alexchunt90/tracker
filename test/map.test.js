/*
 * The projection under the map: Web Mercator and the arithmetic that fits a
 * set of pins into a box. The DOM half of map.js is not required here; only
 * the parts that decide where things go.
 *
 *   node --test test/map.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const MapView = require('../public/map.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('project and unproject are inverses', () => {
  for (const zoom of [0, 3, 10, 17]) {
    for (const [lat, lon] of [[0, 0], [47.55, -123.12], [-33.85, 151.2], [80, 179.9], [-80, -179.9]]) {
      const p = MapView.project(lat, lon, zoom);
      const back = MapView.unproject(p.x, p.y, zoom);
      close(back.lat, lat, 1e-6);
      close(back.lon, lon, 1e-6);
    }
  }
});

test('the world is a square of 256 pixels at zoom 0, doubling per level', () => {
  const nw = MapView.project(85.0511287798, -180, 0);
  const se = MapView.project(-85.0511287798, 180, 0);
  close(nw.x, 0); close(nw.y, 0);
  close(se.x, 256); close(se.y, 256);
  close(MapView.project(0, 0, 4).x, 2048);
  // Latitude beyond the projection's cut-off is clamped, not infinite.
  assert.ok(Number.isFinite(MapView.project(90, 0, 1).y));
  assert.ok(Number.isFinite(MapView.project(-90, 0, 1).y));
});

test('fitting bounds: nothing, one point, and a spread', () => {
  assert.equal(MapView.fitBounds([], 800, 600), null);
  const one = MapView.fitBounds([{ lat: 47.5, lon: -123.1 }], 800, 600);
  assert.deepEqual(one, { lat: 47.5, lon: -123.1, zoom: 15 });
  assert.equal(MapView.fitBounds([{ lat: 47.5, lon: -123.1 }, { lat: 47.5, lon: -123.1 }], 800, 600, { maxZoom: 12 }).zoom, 12);

  const spread = [{ lat: 47.5, lon: -123.2 }, { lat: 47.7, lon: -122.9 }];
  const fit = MapView.fitBounds(spread, 800, 600);
  close(fit.lat, 47.6); close(fit.lon, -123.05);
  // Both corners land inside the viewport at the chosen zoom, and would not
  // one level closer.
  const inside = (zoom) => {
    const a = MapView.project(47.5, -123.2, zoom), b = MapView.project(47.7, -122.9, zoom);
    return Math.abs(b.x - a.x) <= 800 * 0.82 && Math.abs(b.y - a.y) <= 600 * 0.82;
  };
  assert.ok(inside(fit.zoom));
  assert.ok(!inside(fit.zoom + 1));

  // A continent-wide spread bottoms out rather than looping forever.
  assert.equal(MapView.fitBounds([{ lat: -80, lon: -179 }, { lat: 80, lon: 179 }], 10, 10).zoom, 0);
});

test('the main cluster is the largest group of finds within reach of each other', () => {
  // A hunting range, joined up through its neighbours: no two finds at the
  // ends are within two degrees of each other, but each is of the next.
  const range = [
    { lat: 46.86, lon: -121.75 }, { lat: 47.37, lon: -122.10 }, { lat: 47.72, lon: -122.30 },
    { lat: 48.65, lon: -122.42 }, { lat: 49.90, lon: -123.10 },
  ];
  // A trip, with more finds in a day than the range has in a season would be
  // rarer than the reverse, but two is enough to show it is not the count of
  // any one spot that decides.
  const trip = [{ lat: 44.30, lon: -71.30 }, { lat: 44.31, lon: -71.28 }];
  const main = MapView.mainCluster([...trip, ...range, ...trip]);
  assert.deepEqual(main, range);

  // Nothing, and a single find, come back as they are; a tie keeps the earlier group.
  assert.deepEqual(MapView.mainCluster([]), []);
  assert.deepEqual(MapView.mainCluster([trip[0]]), [trip[0]]);
  const tied = MapView.mainCluster([trip[0], range[0]]);
  assert.deepEqual(tied, [trip[0]]);

  // Two groups a point bridges become one, whichever order they arrived in.
  const west = { lat: 47, lon: -123 }, east = { lat: 47, lon: -119.5 }, between = { lat: 47, lon: -121.2 };
  assert.equal(MapView.mainCluster([west, east, between]).length, 3);
  assert.equal(MapView.mainCluster([west, east]).length, 1);

  // Fitting the main cluster is what keeps the opening view legible.
  const fit = MapView.fitBounds(MapView.mainCluster([...range, ...trip]), 800, 600);
  assert.ok(fit.zoom >= 6, `zoom ${fit.zoom} is a continent, not a range`);
  assert.equal(MapView.fitBounds([...range, ...trip], 800, 600).zoom < fit.zoom, true);
});
