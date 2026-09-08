/*
 * The iNaturalist archive's policy: what region it covers, when a copy is
 * old, and whether a viewport can be answered from it.
 *
 * The quiet failure is a map answered from an archive that does not reach
 * its viewport: an empty box that looks exactly like nobody having found
 * anything there. So containment is the test worth having.
 *
 *   node --test test/inat.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const inat = require('../lib/inat.js');

const HOME = { map: { default: { lat: 47.62, lon: -122.33, zoom: 10 } } };

test('the region is a box around the map home, unless config names one', () => {
  const box = inat.regionBox(HOME);
  assert.ok(box.swlat < 47.62 && box.nelat > 47.62);
  assert.ok(box.swlng < -122.33 && box.nelng > -122.33);
  assert.strictEqual(box.nelat - box.swlat, 2 * inat.REGION_SPAN_LAT);

  const named = { swlat: 45, swlng: -125, nelat: 49, nelng: -117 };
  assert.deepStrictEqual(inat.regionBox({ ...HOME, trends: { region: named } }), named);
  // A box the wrong way up is not a region; the default stands in.
  assert.deepStrictEqual(inat.regionBox({ ...HOME, trends: { region: { swlat: 49, swlng: -125, nelat: 45, nelng: -117 } } }), box);
  // No config at all still yields somewhere.
  assert.ok(inat.regionBox(undefined).nelat > inat.regionBox(undefined).swlat);
});

test('the region is clamped to the globe', () => {
  const polar = inat.regionBox({ map: { default: { lat: 89, lon: 179 } } });
  assert.strictEqual(polar.nelat, 90);
  assert.strictEqual(polar.nelng, 180);
});

test('containment is the whole viewport, not most of it', () => {
  const region = { swlat: 45, swlng: -125, nelat: 50, nelng: -118 };
  assert.ok(inat.contains(region, { swlat: 47, swlng: -123, nelat: 48, nelng: -122 }));
  assert.ok(inat.contains(region, region));
  assert.ok(!inat.contains(region, { swlat: 47, swlng: -123, nelat: 50.1, nelng: -122 }));
  assert.ok(!inat.contains(region, { swlat: 44, swlng: -123, nelat: 48, nelng: -122 }));
  assert.ok(!inat.contains(null, region));
  assert.ok(inat.inside(region, 47, -120));
  assert.ok(!inat.inside(region, 47, -117));
});

test('an archive is topped up daily, rebuilt monthly, and resumed if it never finished', () => {
  const region = inat.regionBox(HOME);
  const now = Date.parse('2026-09-08T12:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const fresh = { region, startedAt: iso(now - 3600e3), syncedAt: iso(now - 3600e3), complete: true };
  assert.strictEqual(inat.archiveNeed(fresh, region, now), 'none');
  const stale = { ...fresh, syncedAt: iso(now - inat.INAT_TOPUP_MS - 1) };
  assert.strictEqual(inat.archiveNeed(stale, region, now), 'topup');
  const old = { ...fresh, startedAt: iso(now - inat.INAT_RESYNC_MS - 1) };
  assert.strictEqual(inat.archiveNeed(old, region, now), 'full');
  const unfinished = { ...fresh, complete: false, syncedAt: null };
  assert.strictEqual(inat.archiveNeed(unfinished, region, now), 'topup');
  const elsewhere = { ...fresh, region: { ...region, nelat: region.nelat + 1 } };
  assert.strictEqual(inat.archiveNeed(elsewhere, region, now), 'full');
  assert.strictEqual(inat.archiveNeed(null, region, now), 'full');
  assert.strictEqual(inat.archiveNeed({ region, complete: true }, region, now), 'full');
});

test('taxon ids are integers, deduplicated, and nothing else', () => {
  assert.deepStrictEqual(inat.taxonIds('120443'), [120443]);
  assert.deepStrictEqual(inat.taxonIds('1, 2,1'), [1, 2]);
  assert.strictEqual(inat.taxonIds(''), null);
  assert.strictEqual(inat.taxonIds('abc'), null);
  assert.strictEqual(inat.taxonIds('1,-2'), null);
  assert.strictEqual(inat.taxonIds('1;2'), null);
});

test('ground keys round to about a hundred metres', () => {
  assert.strictEqual(inat.groundKey(47.61234, -122.33456), '47.612_-122.335');
  assert.strictEqual(inat.groundKey(47.6126, -122.3346), inat.groundKey(47.6134, -122.3349));
});

test('the first year shown comes from config or the fallback, never from junk', () => {
  assert.strictEqual(inat.sinceYear({ trends: { since: 2018 } }, 2020), 2018);
  assert.strictEqual(inat.sinceYear({ trends: { since: '2018' } }, 2020), 2018);
  assert.strictEqual(inat.sinceYear({ trends: { since: 'recent' } }, 2020), 2020);
  assert.strictEqual(inat.sinceYear({ trends: { since: 20.5 } }, 2020), 2020);
  assert.strictEqual(inat.sinceYear({}, 2020), 2020);
});

test('cohort edges come from config or the fallback, never from junk', () => {
  assert.deepStrictEqual(inat.bandEdges({ trends: { bands: [500, 1000] } }, [1]), [500, 1000]);
  assert.deepStrictEqual(inat.bandEdges({ trends: { bands: ['x', -1] } }, [1]), [1]);
  assert.deepStrictEqual(inat.bandEdges({}, [300]), [300]);
});
