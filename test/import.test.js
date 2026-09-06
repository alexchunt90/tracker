/*
 * The bulk import's rules: the order the queue shows photographs in, what a
 * group of them says about when and where the find was, and how a batch-wide
 * edit reaches the finds that were not touched by hand.
 *
 *   node --test test/import.test.js
 */
const assert = require('node:assert');
const { test, describe } = require('node:test');
const Model = require('../public/model.js');

const shot = (name, over = {}) => ({ name, takenAt: null, lat: null, lon: null, ...over });

describe('the order of the queue', () => {
  test('by the time taken, the undated last, ties by name with digits read as numbers', () => {
    const rows = Model.importOrder([
      shot('IMG_10.jpg', { takenAt: '2025-10-12T09:30' }),
      shot('IMG_2.jpg', { takenAt: '2025-10-12T09:30' }),
      shot('scan.png'),
      shot('IMG_1.jpg', { takenAt: '2025-10-12T08:41' }),
      shot('another.png'),
      shot('IMG_3.jpg', { takenAt: '2025-10-11T17:05' }),
    ]);
    assert.deepEqual(rows.map((r) => r.name), ['IMG_3.jpg', 'IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg', 'another.png', 'scan.png']);
  });

  test('does not reorder its input', () => {
    const given = [shot('b', { takenAt: '2025-01-02T00:00' }), shot('a', { takenAt: '2025-01-01T00:00' })];
    Model.importOrder(given);
    assert.deepEqual(given.map((r) => r.name), ['b', 'a']);
    assert.deepEqual(Model.importOrder([]), []);
    assert.deepEqual(Model.importOrder(undefined), []);
  });
});

describe('what a group of photographs says', () => {
  test('the earliest clock reading, and the first fix', () => {
    const when = Model.deriveFind([
      shot('b', { takenAt: '2025-10-12T09:30' }),
      shot('a', { takenAt: '2025-10-12T08:41', lat: 47.62, lon: -122.33 }),
      shot('c', { takenAt: '2025-10-12T08:50', lat: 47.63, lon: -122.34 }),
    ]);
    // The fix comes from the first photograph carrying one in the order given,
    // which is the order they were grouped in.
    assert.deepEqual(when, { observedAt: '2025-10-12T08:41', lat: 47.62, lon: -122.33 });
  });

  test('is honestly empty when the files carried nothing', () => {
    assert.deepEqual(Model.deriveFind([shot('a'), shot('b')]), { observedAt: null, lat: null, lon: null });
    assert.deepEqual(Model.deriveFind([]), { observedAt: null, lat: null, lon: null });
  });

  test('half a fix is no fix', () => {
    const when = Model.deriveFind([shot('a', { lat: 47.62, lon: null }), shot('b', { lat: 1, lon: 2 })]);
    assert.deepEqual([when.lat, when.lon], [1, 2]);
  });
});

describe('how a batch edit reaches a find', () => {
  test('a field that still reads what the batch said follows the change', () => {
    const own = { type: 'fungi', place: 'ridge', notes: '' };
    const next = Model.followBatch(own, { place: 'ridge' }, { place: 'Ridge trail, north side' });
    assert.equal(next.place, 'Ridge trail, north side');
    assert.equal(next.type, 'fungi');
    // The find's own object is not touched.
    assert.equal(own.place, 'ridge');
  });

  test('a field edited by hand keeps its own words', () => {
    const own = { place: 'the stump by the creek' };
    const next = Model.followBatch(own, { place: 'ridge' }, { place: 'valley' });
    assert.equal(next.place, 'the stump by the creek');
  });

  test('blank, null and undefined are the same empty field', () => {
    assert.equal(Model.followBatch({ notes: null }, { notes: '' }, { notes: 'wet week' }).notes, 'wet week');
    assert.equal(Model.followBatch({}, { notes: undefined }, { notes: 'wet week' }).notes, 'wet week');
  });

  test('serves the values derived from photographs the same way', () => {
    // Nobody typed a time, so removing the earliest photograph moves it.
    const derived = { observedAt: '2025-10-12T08:41', lat: 47.62, lon: -122.33 };
    const own = { ...derived, place: 'ridge' };
    const later = { observedAt: '2025-10-12T09:30', lat: 47.62, lon: -122.33 };
    assert.equal(Model.followBatch(own, derived, later).observedAt, '2025-10-12T09:30');
    // A time typed over the derived one stays.
    const typed = { ...own, observedAt: '2025-10-12T07:00' };
    assert.equal(Model.followBatch(typed, derived, later).observedAt, '2025-10-12T07:00');
    // Numbers compare as what they read, so a coordinate typed back exactly
    // as it was derived is still the derived one.
    assert.equal(Model.followBatch({ lat: '47.62' }, { lat: 47.62 }, { lat: 47.7 }).lat, 47.7);
  });
});
