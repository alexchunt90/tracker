/*
 * The excerpt markup: what a guide's own words survive as.
 *
 * This is parsing text nobody in this project wrote. A scraping pass hands it
 * whatever a book, a website or an OCR run produced, and the parser has no
 * way to reject any of it — an excerpt that failed to parse would be a page of
 * a field guide that could not be stored. So the property under test is not
 * really "does it format correctly"; it is "is it total, and does it never
 * turn text into markup it was not asked for".
 *
 *   node test/excerpts.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const Model = require('../public/model.js');

/** The rendered text of a block, marks discarded. */
const words = (spans) => spans.map((s) => s.text).join('');
const marked = (spans, mark) => spans.filter((s) => s[mark]).map((s) => s.text);

test('a blank line ends a block; a wrapped line does not', () => {
  // Scraped prose is hard-wrapped at whatever width the page was. Honouring
  // those breaks would rag every paragraph in the library.
  const blocks = Model.richText('Cap 3-10 cm,\nbroadly convex.\n\nFlesh white.');
  assert.equal(blocks.length, 2);
  assert.equal(words(blocks[0].spans), 'Cap 3-10 cm, broadly convex.');
  assert.equal(words(blocks[1].spans), 'Flesh white.');
});

test('bold and italics come out as marks, not as asterisks', () => {
  const [block] = Model.richText('A **stout** stipe, *viscid* when wet.');
  assert.equal(words(block.spans), 'A stout stipe, viscid when wet.');
  assert.deepEqual(marked(block.spans, 'bold'), ['stout']);
  assert.deepEqual(marked(block.spans, 'italic'), ['viscid']);
});

test('emphasis nests both ways round', () => {
  const [triple] = Model.richText('***strongly*** fragrant');
  assert.deepEqual(triple.spans[0], { bold: true, italic: true, text: 'strongly' });

  const [nested] = Model.richText('*Amanita **muscaria** var. flavivolvata*');
  assert.deepEqual(marked(nested.spans, 'italic'), ['Amanita ', 'muscaria', ' var. flavivolvata']);
  assert.deepEqual(marked(nested.spans, 'bold'), ['muscaria']);
});

test('a run of bullets is one list, and the prose around it is not in it', () => {
  const blocks = Model.richText('Told apart by:\n- **false gills**\n- a rust spore print\n\nTrudell & Ammirati disagree.');
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph', 'list', 'paragraph']);
  assert.deepEqual(blocks[1].items.map(words), ['false gills', 'a rust spore print']);
  assert.equal(words(blocks[2].spans), 'Trudell & Ammirati disagree.');
});

/*
 * The two ways a mushroom description is written that would break a naive
 * parser. Both appear in the guides this library is built from.
 */
test('measurements are not emphasis', () => {
  // "5 * 3 µm" twice in a paragraph is two multiplication signs, not an
  // italicised twelve words. The guard is that an opener must be followed by
  // a non-space.
  const [block] = Model.richText('Spores 5 * 3 µm, basidia 30 * 8 µm.');
  assert.equal(words(block.spans), 'Spores 5 * 3 µm, basidia 30 * 8 µm.');
  assert.deepEqual(marked(block.spans, 'italic'), []);
});

test('an unpaired asterisk is an asterisk', () => {
  const [block] = Model.richText('Edible* — see the footnote.');
  assert.equal(words(block.spans), 'Edible* — see the footnote.');
  assert.deepEqual(marked(block.spans, 'italic'), []);
});

test('a paragraph opening on italics is not a bullet', () => {
  // `*Cantharellus* is common` starts with an asterisk, and a bullet rule that
  // did not require the space would eat the opening word of the sentence.
  const [block] = Model.richText('*Cantharellus formosus* is the common one.');
  assert.equal(block.kind, 'paragraph');
  assert.deepEqual(marked(block.spans, 'italic'), ['Cantharellus formosus']);
});

test('nothing in an excerpt survives as markup', () => {
  // The text is somebody else's page. It goes to the renderer as spans and is
  // put on screen as text nodes; there is no path by which it becomes an
  // element of this one.
  const [block] = Model.richText('Compare <i>Amanita</i> & <script>alert(1)</script>.');
  assert.equal(words(block.spans), 'Compare <i>Amanita</i> & <script>alert(1)</script>.');
});

test('the parser is total', () => {
  // Every one of these has to come back as blocks rather than an exception:
  // the alternative is a scraping pass that loses a page it already fetched.
  for (const input of [undefined, null, '', '   ', '\n\n\n', '***', '*', '**a', '- ', '•\t', 'a\r\nb']) {
    assert.ok(Array.isArray(Model.richText(input)), `${JSON.stringify(input)} did not parse`);
  }
  assert.deepEqual(Model.richText('\n\n\n'), []);
  assert.equal(words(Model.richText('a\r\nb')[0].spans), 'a b');
});

test('excerpts read back as a list, whatever the record holds', () => {
  // Absent means none. A species from before this field existed is not a
  // species with an empty guide entry, and both have to read the same.
  assert.deepEqual(Model.excerpts({}), []);
  assert.deepEqual(Model.excerpts({ excerpts: null }), []);

  // Blank cards are dropped; a source with no text yet is kept, because it is
  // a book somebody has named and not yet read.
  const list = Model.excerpts({ excerpts: [
    { source: '  Trudell & Ammirati  ', text: 'Cap\r\nviscid.\n' },
    { source: '', text: '' },
    { source: 'Arora', text: '' },
    'nonsense',
  ] });
  assert.deepEqual(list, [
    { source: 'Trudell & Ammirati', text: 'Cap\nviscid.' },
    { source: 'Arora', text: '' },
  ]);
});

/*
 * The species search box, which is names-only. Kept here because the change
 * that narrowed it and the change that added excerpts are the same change:
 * once a record can hold a page of a field guide, a search that matched every
 * word of the record would match almost every record.
 */
test('the search box matches names and nothing else', () => {
  const sp = {
    commonName: 'Golden Chanterelle',
    scientificName: 'Cantharellus formosus',
    synonyms: ['Cantharellus roseocanus'],
    formerNames: ['Cantharellus cibarius'],
    habitat: 'Douglas fir duff, mossy slopes',
    lookalikes: 'Jack-o’-lantern; false chanterelle',
    division: 'Basidiomycota',
    edibility: 'choice',
    nutrition: 'mycorrhizal',
    characters: { cap: { na: false, tags: [{ text: 'egg-yellow' }] } },
  };
  const hay = Model.speciesText(sp);

  // All four kinds of name, because records exist under all of them.
  for (const q of ['golden chanterelle', 'formosus', 'roseocanus', 'cibarius']) {
    assert.ok(hay.includes(q), `${q} should be searchable`);
  }
  // And nothing else. `jack-o’-lantern` is the case that motivated this: two
  // thirds of the library names a lookalike, so searching for one used to
  // return every species that warns about it.
  for (const q of ['douglas', 'jack', 'basidiomycota', 'egg-yellow', 'choice', 'mycorrhizal']) {
    assert.ok(!hay.includes(q), `${q} should not be searchable`);
  }
});

test('a species with only a scientific name is still findable', () => {
  // Most of this library has no vernacular name at all.
  assert.equal(Model.speciesText({ scientificName: 'Agrocybe semiorbicularis' }),
    'agrocybe semiorbicularis');
  assert.equal(Model.speciesText({ commonName: '', scientificName: '' }), '');
});
