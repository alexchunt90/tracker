/*
 * The log's rules, apart from the ones with a file of their own.
 *
 * Colour, measures and excerpts each have a test file. This holds the rest:
 * how a find gets its name, what the summary counts, how the filter cuts,
 * the three states of a character and the matching built on them.
 *
 *   node --test test/model.test.js
 */
const assert = require('node:assert');
const { test, describe, beforeEach } = require('node:test');
const Model = require('../public/model.js');

const SPECIES = [
  { id: 'chant', kind: 'fungi', commonName: 'Chanterelle', scientificName: 'Cantharellus formosus', edibility: 'choice',
    characters: { body: { na: false, tags: [{ text: 'cantharelloid' }] }, hymenium: { na: false, tags: [{ text: 'false gills' }, { text: 'decurrent' }] }, stipe: { na: false, tags: [{ text: 'solid' }] } } },
  { id: 'conk', kind: 'fungi', commonName: 'Red-belt Conk', scientificName: 'Fomitopsis pinicola', edibility: 'inedible',
    characters: { body: { na: false, tags: [{ text: 'bracket' }] }, hymenium: { na: false, tags: [{ text: 'pores' }] }, stipe: { na: true } } },
  { id: 'cap', kind: 'fungi', commonName: 'Death Cap', scientificName: 'Amanita phalloides', edibility: 'deadly',
    characters: { hymenium: { na: false, tags: [{ text: 'gills' }, { text: 'free' }] } } },
  { id: 'nettle', kind: 'flora', commonName: '', scientificName: 'Urtica dioica', edibility: 'edible' },
];
const index = Model.byId(SPECIES);

const find = (over) => ({ id: 'f', type: 'fungi', speciesId: null, confidence: 'high', photos: [], ...over });

beforeEach(() => Model.applyGlossary({ terms: {} }));

describe('what a find is called', () => {
  test('the name is derived from the species, never stored', () => {
    assert.equal(Model.view(find(), index).name, 'Unidentified');
    const named = Model.view(find({ speciesId: 'chant' }), index);
    assert.equal(named.name, 'Chanterelle');
    assert.equal(named.scientificName, 'Cantharellus formosus');
    assert.equal(named.identified, true);
    // A guess keeps its question mark, so it cannot pass for a settled call.
    assert.equal(Model.view(find({ speciesId: 'chant', confidence: 'low' }), index).name, 'Chanterelle?');
    assert.equal(Model.view(find({ speciesId: 'chant', confidence: 'low' }), index).uncertain, true);
  });

  test('a species with no common name goes by its binomial', () => {
    assert.equal(Model.view(find({ speciesId: 'nettle', type: 'fungi' }), index).name, 'Urtica dioica');
  });

  test('type follows the species; a deleted species reads as unidentified', () => {
    const row = Model.view(find({ speciesId: 'nettle', type: 'fungi' }), index);
    assert.equal(row.type, 'flora');
    const dangling = Model.view(find({ speciesId: 'gone' }), index);
    assert.equal(dangling.identified, false);
    assert.equal(dangling.name, 'Unidentified');
    assert.equal(dangling.species, null);
  });

  test('a place is two finite numbers, and an elevation prefers the record over the photographs', () => {
    assert.equal(Model.view(find({ lat: 47, lon: -123 }), index).hasPlace, true);
    assert.equal(Model.view(find({ lat: 47 }), index).hasPlace, false);
    assert.equal(Model.view(find({ lat: '47', lon: '-123' }), index).hasPlace, false);
    const photos = [{ altitude: 300 }, { altitude: 900 }, { altitude: 310 }, { altitude: null }];
    assert.deepEqual(Model.view(find({ photos }), index).elevation, { metres: 310, source: 'photo', samples: 3 });
    assert.deepEqual(Model.view(find({ photos, elevation: 412.4 }), index).elevation, { metres: 412, source: 'recorded' });
    assert.equal(Model.view(find(), index).elevation, null);
    // An even count takes the midpoint of the two middles.
    assert.equal(Model.photoElevation({ photos: [{ altitude: 100 }, { altitude: 200 }] }).metres, 150);
  });
});

describe('summary and life list', () => {
  const rows = Model.viewAll([
    find({ id: 'a', speciesId: 'chant', observedAt: '2025-10-01T10:00', lat: 47, lon: -123 }),
    find({ id: 'b', speciesId: 'chant', confidence: 'low', observedAt: '2025-09-01T10:00' }),
    find({ id: 'c', speciesId: 'nettle', type: 'flora', observedAt: '2025-04-01T10:00' }),
    find({ id: 'd', observedAt: null }),
  ], SPECIES);

  test('the counts add up', () => {
    const s = Model.summary(rows);
    assert.equal(s.total, 4);
    assert.deepEqual(s.counts, { fungi: 3, flora: 1, fauna: 0 });
    assert.equal(s.identified, 3);
    assert.equal(s.unidentified, 1);
    assert.equal(s.uncertain, 1);
    assert.equal(s.placed, 1);
    // Species met, not species on file.
    assert.equal(s.speciesSeen, 2);
    assert.equal(s.identifiedShare, 0.75);
    assert.equal(s.latest.id, 'a');
  });

  test('the life list keeps unmet species at zero', () => {
    const life = Model.lifeList(SPECIES, rows);
    const chant = life.find((x) => x.id === 'chant');
    assert.equal(chant.count, 2);
    assert.equal(chant.uncertain, 1);
    assert.equal(chant.first, '2025-09-01T10:00');
    assert.equal(chant.last, '2025-10-01T10:00');
    assert.equal(chant.seen, true);
    const conk = life.find((x) => x.id === 'conk');
    assert.equal(conk.count, 0);
    assert.equal(conk.seen, false);
  });

  test('the filter narrows by type, status, edibility and text; empty sets show nothing', () => {
    const ids = (f) => Model.filter(rows, f).map((r) => r.id);
    assert.deepEqual(ids({}), ['a', 'b', 'c', 'd']);
    assert.deepEqual(ids({ types: ['flora'] }), ['c']);
    assert.deepEqual(ids({ types: [] }), []);
    assert.deepEqual(ids({ status: 'unidentified' }), ['d']);
    assert.deepEqual(ids({ status: 'uncertain' }), ['b']);
    assert.deepEqual(ids({ speciesId: 'chant' }), ['a', 'b']);
    assert.deepEqual(ids({ edibility: ['choice'] }), ['a', 'b']);
    // An unidentified find is "not recorded", so the tiers sum to the total.
    assert.deepEqual(ids({ edibility: ['unknown'] }), ['d']);
    assert.deepEqual(ids({ q: 'urtica' }), ['c']);
    assert.deepEqual(ids({ q: 'FLORA' }), ['c']);
  });

  test('undated finds sort last, whichever way the dates go', () => {
    assert.deepEqual(Model.sortByDate(rows).map((r) => r.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(Model.sortByDate(rows, 'asc').map((r) => r.id), ['c', 'b', 'a', 'd']);
  });
});

describe('characters', () => {
  test('absent, recorded and unrecorded never collapse into each other', () => {
    assert.equal(Model.character(SPECIES[1], 'stipe').state, 'absent');
    assert.equal(Model.character(SPECIES[1], 'hymenium').state, 'recorded');
    assert.equal(Model.character(SPECIES[1], 'cap').state, 'unrecorded');
    assert.equal(Model.character({}, 'cap').state, 'unrecorded');
    assert.equal(Model.character(null, 'cap').state, 'unrecorded');
  });

  test('older shapes read forward: prose, a bare list, and the two tri-states', () => {
    const prose = Model.character({ characters: { cap: 'convex, viscid; pale yellow' } }, 'cap');
    assert.deepEqual(prose.tags.map((t) => [t.text, t.category]),
      [['convex', 'descriptor'], ['viscid', 'descriptor'], ['pale yellow', 'secondary']]);
    const list = Model.character({ characters: { cap: ['convex', 'Convex', ' viscid '] } }, 'cap');
    assert.deepEqual(list.tags.map((t) => t.text), ['convex', 'viscid']);
    assert.equal(Model.character({ gills: 'no' }, 'hymenium').state, 'absent');
    assert.deepEqual(Model.character({ gills: 'yes' }, 'hymenium').tags, [{ text: 'gills', category: 'form' }]);
    assert.equal(Model.character({ stipe: 'yes' }, 'stipe').tags[0].text, 'stipe');
  });

  test('a stored category is honoured; the vocabulary is only a guess', () => {
    const c = Model.character({ characters: { cap: { tags: [{ text: 'apricot', category: 'descriptor' }] } } }, 'cap');
    assert.equal(c.tags[0].category, 'descriptor');
    // Under scent, a colour word is a smell.
    assert.equal(Model.classifyTag('apricot', Model.characterSpec('scent')), 'descriptor');
    assert.equal(Model.classifyTag('apricot', Model.characterSpec('cap')), 'secondary');
  });

  test('the glossary can reclassify a word and make two words one', () => {
    assert.equal(Model.classifyTag('angular'), 'note');
    Model.applyGlossary({ terms: { angular: { category: 'descriptor' }, ridges: { sameAs: 'false gills' } } });
    assert.equal(Model.classifyTag('angular'), 'descriptor');
    assert.equal(Model.guessCategory('angular'), 'note');
    assert.equal(Model.termGroup('ridges'), Model.termGroup('false gills'));
    assert.ok(Model.synonymsOf('false gills', ['ridges']).includes('ridges'));
  });

  test('traits are silent on what is unsaid and keep division and nutrition last', () => {
    const traits = Model.fungiTraits({ ...SPECIES[1], division: 'Basidiomycota', nutrition: 'saprophytic' });
    assert.deepEqual(traits.map((t) => t.label), ['Fruit body', 'Gills / pores', 'Stipe', 'Division', 'Nutrition']);
    assert.equal(traits[2].absent, true);
    assert.equal(traits[2].value, 'Sessile — no stipe');
    assert.equal(traits[4].value, 'Saprophytic');
    assert.deepEqual(Model.fungiTraits(SPECIES[3]), []);
  });
});

describe('identification', () => {
  const seen = (characters) => ({ type: 'fungi', characters });

  test('a species is ruled out only by contradiction, never by silence', () => {
    // Gills seen; the conk is recorded with pores and no stipe. Pores do not
    // contradict gills (both are recorded under one character), but a stipe
    // does contradict "no stipe".
    const specimen = seen({ hymenium: { tags: [{ text: 'gills' }] }, stipe: { tags: [{ text: 'stipe' }] } });
    const conk = Model.matchSpecies(specimen, SPECIES[1]);
    assert.equal(conk.contradicted, true);
    assert.equal(conk.conflicts[0].reason, 'Sessile — no stipe');
    // The death cap says nothing about its stipe, so it is not ruled out.
    const cap = Model.matchSpecies(specimen, SPECIES[2]);
    assert.equal(cap.contradicted, false);
    assert.equal(cap.score, 1);
    assert.equal(cap.unmatched, 0);
  });

  test('synonyms match; a bare colour does not agree with a bruise', () => {
    const specimen = seen({ hymenium: { tags: [{ text: 'ridges' }] } });
    Model.applyGlossary({ terms: { ridges: { sameAs: 'false gills' } } });
    assert.equal(Model.matchSpecies(specimen, SPECIES[0]).score, 1);

    const blue = { kind: 'fungi', characters: { staining: { tags: [{ text: 'bruises blue' }] } } };
    assert.equal(Model.matchSpecies(seen({ staining: { tags: [{ text: 'blue' }] } }), blue).score, 0);
    // The tag filter is the wide net; the matcher is not.
    assert.ok(Model.speciesHasTag(blue, 'blue'));
    assert.ok(!Model.speciesHasTag({ kind: 'fungi', characters: { cap: { tags: [{ text: 'blue' }] } } }, 'bruises blue'));
  });

  test('growth forms rule out across synonym groups, and unknown forms never do', () => {
    const polypore = seen({ body: { tags: [{ text: 'polypore', category: 'form' }] } });
    assert.equal(Model.matchSpecies(polypore, SPECIES[1]).contradicted, false); // bracket
    assert.equal(Model.matchSpecies(polypore, SPECIES[0]).contradicted, true);  // cantharelloid
    const fan = seen({ body: { tags: [{ text: 'fan', category: 'form' }] } });
    assert.equal(Model.matchSpecies(fan, SPECIES[0]).contradicted, false);
  });

  test('ranking puts contradicted species last and never drops them', () => {
    const specimen = seen({ hymenium: { tags: [{ text: 'gills' }] }, stipe: { tags: [{ text: 'stipe' }] } });
    const { rows, anyTags, pool } = Model.rankCandidates(specimen, SPECIES);
    assert.equal(pool, 3);
    assert.equal(anyTags, true);
    assert.deepEqual(rows.map((r) => r.species.id), ['cap', 'chant', 'conk']);
    assert.equal(rows[2].contradicted, true);
    assert.equal(Model.rankCandidates(seen({}), SPECIES).anyTags, false);
    assert.equal(Model.rankCandidates(seen({}), SPECIES, { type: 'flora' }).pool, 1);
  });
});

describe('names and edibility', () => {
  test('every name that means this organism, once, and never a relative', () => {
    const names = Model.speciesNames({ scientificName: 'A b', synonyms: ['C d', 'a B'], formerNames: ['E f', ''], relatives: ['G h'] });
    assert.deepEqual(names, ['A b', 'C d', 'E f']);
    assert.deepEqual(Model.speciesNames(null), []);
  });

  test('edibility is a scale from the kitchen to the morgue', () => {
    const ranks = Model.EDIBILITY.map((e) => e.rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.equal(Model.edibility('nonsense').id, 'unknown');
    assert.ok(Model.isDangerous({ edibility: 'deadly' }));
    assert.ok(Model.isDangerous({ edibility: 'toxic' }));
    assert.ok(!Model.isDangerous({ edibility: 'dubious' }));
    assert.ok(Model.isDubious({ edibility: 'dubious' }));
    assert.ok(!Model.isChoice(null));
    const counts = Model.edibilityCounts(Model.viewAll([find({ speciesId: 'chant' }), find()], SPECIES));
    assert.equal(counts.choice, 1);
    assert.equal(counts.unknown, 1);
  });

  test('records fade with age but never to nothing', () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const day = 86400000;
    assert.equal(Model.ageOpacity('2026-09-01', now), 1);
    assert.equal(Model.ageOpacity(new Date(now - 200 * day).toISOString(), now), 0.75);
    assert.equal(Model.ageOpacity(new Date(now - 500 * day).toISOString(), now), 0.5);
    assert.equal(Model.ageOpacity('2000-01-01', now), 0.25);
    assert.equal(Model.ageOpacity(null, now), 0.75);
    // A date in the future is a data error, not a fresh find.
    assert.equal(Model.ageOpacity('2030-01-01', now), 1);
  });

  test('coordinates and elevations are written one way', () => {
    assert.equal(Model.formatCoord(47.55123, -123.1181), '47.5512°N, 123.1181°W');
    assert.equal(Model.formatCoord(-33.9, 151.2), '33.9000°S, 151.2000°E');
    assert.equal(Model.formatCoord(null, 1), '');
    assert.equal(Model.formatElevation(412.6), '413 m');
    assert.equal(Model.formatElevation(NaN), '');
    assert.match(Model.mapLink(47.5, -123.1), /^https:\/\/www\.openstreetmap\.org\/\?mlat=47\.5&mlon=-123\.1/);
    assert.equal(Model.mapLink(null, null), null);
  });
});
