/*
 * Colour, in two tiers.
 *
 * The properties worth holding: the core set stays small; every secondary
 * names a primary that exists; a shade built from a modifier is a secondary
 * of the colour it ends in; matching folds a secondary onto its primary and
 * nothing else does; and the glossary can make a word a secondary colour
 * without an edit to the tables.
 *
 *   node test/colours.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const Model = require('../public/model.js');

const fresh = () => Model.applyGlossary({ terms: {} });

test('the core set is small and every secondary points into it', () => {
  fresh();
  const primaries = Object.keys(Model.PRIMARY_COLOURS);
  assert.ok(primaries.length <= 30, `${primaries.length} primaries`);
  for (const [name, entry] of Object.entries(Model.SECONDARY_COLOURS)) {
    assert.ok(Model.PRIMARY_COLOURS[entry.of], `${name} -> ${entry.of}`);
    assert.ok(!Model.PRIMARY_COLOURS[name], `${name} is in both tiers`);
    assert.match(entry.swatch, /^#[0-9a-f]{6}$/);
  }
  for (const name of primaries) assert.match(Model.PRIMARY_COLOURS[name], /^#[0-9a-f]{6}$/);
});

test('primary, secondary, derived, and not a colour at all', () => {
  fresh();
  assert.strictEqual(Model.classifyTag('yellow'), 'colour');
  assert.strictEqual(Model.primaryOf('yellow'), null);
  assert.strictEqual(Model.classifyTag('apricot'), 'secondary');
  assert.strictEqual(Model.primaryOf('apricot'), 'orange');
  // A shade with something in front of it reads as the colour it ends in.
  assert.strictEqual(Model.classifyTag('pale yellow'), 'secondary');
  assert.strictEqual(Model.primaryOf('pale yellow'), 'yellow');
  assert.strictEqual(Model.primaryOf('olive-brown'), 'brown');
  // ...by way of a secondary, when that is what it ends in.
  assert.strictEqual(Model.primaryOf('pale red-brown'), 'brown');
  assert.strictEqual(Model.primaryOf('greyish vinaceous'), 'purple');
  // The pair that started this now read as one colour each, and differ only
  // in which: the word they end in.
  assert.strictEqual(Model.primaryOf('whitish yellow'), 'yellow');
  assert.strictEqual(Model.primaryOf('yellowish white'), 'white');
  // Colours taken out of the vocabulary are notes again, and a modifier on
  // its own is not a colour.
  assert.strictEqual(Model.classifyTag('egg-yellow'), 'note');
  assert.strictEqual(Model.classifyTag('pale'), 'note');
  // The exact-match rule still wins: a bruise is a descriptor, not a shade.
  assert.strictEqual(Model.classifyTag('bruises blue'), 'descriptor');
});

test('under scent, a shade is a smell like any colour', () => {
  fresh();
  const scent = Model.characterSpec('scent');
  assert.strictEqual(Model.classifyTag('apricot', scent), 'descriptor');
  assert.strictEqual(Model.classifyTag('pale yellow', scent), 'descriptor');
});

test('a secondary paints its own swatch, or its primary\'s', () => {
  fresh();
  assert.strictEqual(Model.tagSwatch('apricot'), Model.SECONDARY_COLOURS.apricot.swatch);
  assert.strictEqual(Model.tagSwatch('pale yellow'), Model.PRIMARY_COLOURS.yellow);
  Model.applyGlossary({ terms: { eggshell: { category: 'secondary', primary: 'white' } } });
  assert.strictEqual(Model.tagSwatch('eggshell'), Model.PRIMARY_COLOURS.white);
  fresh();
});

test('matching folds a secondary onto its primary', () => {
  fresh();
  assert.strictEqual(Model.termGroup('reddish brown'), 'brown');
  assert.strictEqual(Model.termGroup('red-brown'), 'brown');
  assert.strictEqual(Model.termGroup('brown'), 'brown');
  const species = { kind: 'fungi', characters: { cap: { na: false, tags: [{ text: 'brown' }] } } };
  const find = { type: 'fungi', characters: { cap: { na: false, tags: [{ text: 'reddish brown', category: 'secondary' }] } } };
  assert.strictEqual(Model.matchSpecies(find, species).matched.length, 1);
  // And the other way round: a shade in the library is found by its colour.
  const shaded = { kind: 'fungi', characters: { cap: { na: false, tags: [{ text: 'red-brown' }] } } };
  assert.ok(Model.speciesHasTag(shaded, 'brown'));
  assert.ok(Model.speciesHasTag(shaded, 'reddish brown'));
  assert.ok(!Model.speciesHasTag(shaded, 'red'));
});

test('a shade is not listed as a synonym of its primary', () => {
  fresh();
  assert.deepStrictEqual(Model.synonymsOf('brown', ['red-brown', 'reddish brown', 'tawny']), []);
  assert.deepStrictEqual(Model.synonymsOf('red-brown', ['brown']), []);
  // Hand-set synonyms and growth forms are unaffected.
  assert.deepStrictEqual(Model.synonymsOf('bracket', []), ['polypore', 'polyporoid']);
});

test('the glossary can make any word a secondary colour', () => {
  Model.applyGlossary({ terms: { eggshell: { category: 'secondary', primary: 'white' } } });
  assert.strictEqual(Model.classifyTag('eggshell'), 'secondary');
  assert.strictEqual(Model.primaryOf('eggshell'), 'white');
  assert.strictEqual(Model.termGroup('eggshell'), 'white');
  // The vocabulary's own guess is unchanged, which is what the glossary
  // compares against to know whether the override is redundant.
  assert.strictEqual(Model.guessPrimary('eggshell'), null);
  assert.strictEqual(Model.guessPrimary('apricot'), 'orange');
  // A primary that is not a core colour is ignored rather than trusted.
  Model.applyGlossary({ terms: { eggshell: { category: 'secondary', primary: 'eggy' } } });
  assert.strictEqual(Model.primaryOf('eggshell'), null);
  // The glossary can also move a listed shade to a different primary.
  Model.applyGlossary({ terms: { vinaceous: { category: 'secondary', primary: 'red' } } });
  assert.strictEqual(Model.primaryOf('vinaceous'), 'red');
  assert.strictEqual(Model.primaryOf('vinaceous brown'), 'brown');
  fresh();
});

test('a synonym set by hand still beats the colour fold', () => {
  Model.applyGlossary({ terms: { tawny: { sameAs: 'ochre' } } });
  assert.strictEqual(Model.termGroup('tawny'), 'ochre');
  fresh();
});
