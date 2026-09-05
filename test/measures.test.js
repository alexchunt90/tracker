/*
 * Measures: a size is a tag that is a number.
 *
 * The properties worth holding: every whole centimetre under two metres is a
 * measure and nothing else is; the ways a size was written before this
 * existed read forward to the same tags typing it today would give; a species
 * reads as a range and a find is matched against it by number, not by
 * spelling; and a spore measurement never becomes one.
 *
 *   node test/measures.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const Model = require('../public/model.js');

const values = (text) => Model.parseMeasure(text)?.values;

test('the shapes a size is written in', () => {
  assert.deepStrictEqual(values('20'), [20]);
  assert.deepStrictEqual(values('20 cm'), [20]);
  assert.deepStrictEqual(values('20cm'), [20]);
  assert.deepStrictEqual(values('3-10 cm'), [3, 10]);
  assert.deepStrictEqual(values('3–10 cm'), [3, 10]);
  assert.deepStrictEqual(values('3 to 10 cm'), [3, 10]);
  assert.deepStrictEqual(values('up to 20 cm'), [20]);
  // Other units land in centimetres.
  assert.deepStrictEqual(values('5 mm'), [1]);
  assert.deepStrictEqual(values('1.5 m'), [150]);
  // Whole numbers: rounded, and never down to nothing.
  assert.deepStrictEqual(values('2.5 cm'), [3]);
  assert.deepStrictEqual(values('0.2 cm'), [1]);
  // A range written backwards or collapsed is still one range.
  assert.deepStrictEqual(values('10–3 cm'), [3, 10]);
  assert.deepStrictEqual(values('5–5 cm'), [5]);
});

test('what is not a size', () => {
  assert.strictEqual(Model.parseMeasure('convex'), null);
  // Spore measurements are microns and a pair; they stay notes.
  assert.strictEqual(Model.parseMeasure('8–11 × 5–6 µm'), null);
  assert.strictEqual(Model.classifyTag('8–11 × 5–6 µm'), 'note');
  // A count is not a size.
  assert.strictEqual(Model.parseMeasure('3–5 per mm'), null);
  assert.strictEqual(Model.classifyTag('3–5 per mm'), 'note');
  // Prose around a number is not a size either.
  assert.strictEqual(Model.parseMeasure('20 cm broad'), null);
  assert.strictEqual(Model.parseMeasure(''), null);
});

test('the ceiling is refused with a reason, not filed as a note', () => {
  const big = Model.parseMeasure('250 cm');
  assert.deepStrictEqual(big.values, []);
  assert.match(big.error, /200/);
  assert.strictEqual(Model.parseMeasure('199 cm').error, null);
  assert.match(Model.parseMeasure('200 cm').error, /200/);
  const typed = Model.tagsFrom('3 m', Model.characterSpec('cap'));
  assert.deepStrictEqual(typed.tags, []);
  assert.ok(typed.error);
  // One already stored stays visible as a note rather than vanishing on read.
  assert.strictEqual(Model.classifyTag('250 cm'), 'note');
  assert.deepStrictEqual(Model.character({ characters: { cap: { na: false, tags: [{ text: '250 cm' }] } } }, 'cap').tags,
    [{ text: '250 cm', category: 'note' }]);
});

test('a size classifies as a measure whatever character it sits under', () => {
  for (const spec of Model.FUNGI_CHARACTERS) {
    assert.strictEqual(Model.classifyTag('20 cm', spec), 'measure', spec.id);
  }
  assert.strictEqual(Model.classifyTag('20 cm', null), 'measure');
});

test('typing a range gives its two ends', () => {
  const spec = Model.characterSpec('cap');
  assert.deepStrictEqual(Model.tagsFrom('3–10 cm', spec).tags, [
    { text: '3 cm', category: 'measure' },
    { text: '10 cm', category: 'measure' },
  ]);
  assert.deepStrictEqual(Model.tagsFrom('viscid', spec).tags, [{ text: 'viscid', category: 'descriptor' }]);
});

test('sizes written before measures were numbers read forward', () => {
  const sp = { kind: 'fungi', characters: {
    cap: { na: false, tags: [{ text: 'up to 20 cm' }, { text: 'viscid' }] },
    // A stored category does not make a size a word.
    stipe: { na: false, tags: [{ text: '3–10 cm', category: 'note' }, { text: '3 cm' }, { text: 'equal' }] },
    body: 'agaricoid, 8 cm',
  } };
  assert.deepStrictEqual(Model.character(sp, 'cap').tags, [
    { text: '20 cm', category: 'measure' }, { text: 'viscid', category: 'descriptor' },
  ]);
  // The range splits, and the duplicate it makes is dropped.
  assert.deepStrictEqual(Model.character(sp, 'stipe').tags.map((t) => t.text), ['3 cm', '10 cm', 'equal']);
  assert.deepStrictEqual(Model.character(sp, 'body').tags.map((t) => t.text), ['agaricoid', '8 cm']);
});

test('a species reads as a range', () => {
  const tag = (text) => ({ text, category: 'measure' });
  assert.strictEqual(Model.measureRange([]), null);
  assert.strictEqual(Model.measureRange([{ text: 'convex', category: 'descriptor' }]), null);
  // One measure is a ceiling with no floor.
  assert.deepStrictEqual(Model.measureRange([tag('8 cm')]), { min: null, max: 8, text: 'to 8 cm' });
  // Two or more: smallest and largest, whatever was tagged between.
  assert.deepStrictEqual(Model.measureRange([tag('10 cm'), tag('3 cm'), tag('6 cm')]), { min: 3, max: 10, text: '3–10 cm' });
  assert.ok(Model.withinRange(3, { min: 3, max: 10 }));
  assert.ok(Model.withinRange(10, { min: 3, max: 10 }));
  assert.ok(!Model.withinRange(11, { min: 3, max: 10 }));
  assert.ok(!Model.withinRange(2, { min: 3, max: 10 }));
  assert.ok(Model.withinRange(1, { min: null, max: 8 }));
  assert.ok(!Model.withinRange(9, { min: null, max: 8 }));
  assert.ok(!Model.withinRange(9, null));
});

test('reading surfaces fold the measures into one chip, first', () => {
  const sp = { kind: 'fungi', characters: {
    cap: { na: false, tags: [{ text: 'convex' }, { text: '3 cm' }, { text: '10 cm' }] },
  } };
  const [cap] = Model.fungiTraits(sp);
  assert.strictEqual(cap.value, '3–10 cm, convex');
  assert.strictEqual(cap.tags[0].category, 'measure');
  assert.deepStrictEqual(cap.tags[0].range, { min: 3, max: 10, text: '3–10 cm' });
  // The editor still sees the two tags it can remove one at a time.
  assert.strictEqual(Model.character(sp, 'cap').tags.length, 3);
});

test('a find is matched against the range by number, not by spelling', () => {
  const species = { kind: 'fungi', characters: {
    cap: { na: false, tags: [{ text: '3 cm' }, { text: '10 cm' }, { text: 'convex' }] },
    stipe: { na: false, tags: [{ text: '8 cm' }] },
  } };
  const find = (cap, stipe) => ({ type: 'fungi', characters: {
    cap: { na: false, tags: [{ text: cap, category: 'measure' }] },
    stipe: { na: false, tags: [{ text: stipe, category: 'measure' }] },
  } });

  // No tag on the species says "8 cm", and it still agrees.
  const fits = Model.matchSpecies(find('8 cm', '5 cm'), species);
  assert.strictEqual(fits.matched.length, 2);
  assert.strictEqual(fits.unmatched, 0);
  assert.deepStrictEqual(fits.matched[0].range, { min: 3, max: 10, text: '3–10 cm' });

  // Outside the range fails to score — and never rules the species out.
  const misses = Model.matchSpecies(find('12 cm', '9 cm'), species);
  assert.strictEqual(misses.matched.length, 0);
  assert.strictEqual(misses.unmatched, 2);
  assert.strictEqual(misses.contradicted, false);

  // A species with no size recorded is not confirmed by one.
  const silent = { kind: 'fungi', characters: { cap: { na: false, tags: [{ text: 'convex' }] } } };
  const against = Model.matchSpecies(find('8 cm', '5 cm'), silent);
  assert.strictEqual(against.matched.length, 0);
});

test('the tag filter finds a species by the size it takes in', () => {
  const species = { kind: 'fungi', characters: {
    cap: { na: false, tags: [{ text: '3 cm' }, { text: '10 cm' }] },
  } };
  assert.ok(Model.speciesHasTag(species, '8 cm'));
  assert.ok(Model.speciesHasTag(species, '8'));
  assert.ok(!Model.speciesHasTag(species, '12 cm'));
});
