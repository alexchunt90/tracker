/* ==========================================================================
   The log's rules. No DOM here.

   One idea does most of the work: an observation's *name* is not stored. It is
   derived from the species it points at, so correcting a species — or finally
   identifying something six months later — renames every observation of it at
   once. A stored name would have to be found and rewritten, and the ones that
   were missed would quietly disagree with the species record.
   ========================================================================== */

'use strict';

const Model = (() => {
  // Fungi first: this is a mushroom log that also takes plants.
  const TYPES = [
    { id: 'fungi', label: 'Fungi', glyph: '🍄' },
    { id: 'flora', label: 'Flora', glyph: '🌿' },
    { id: 'fauna', label: 'Fauna', glyph: '🦋' },
  ];
  const TYPE_IDS = TYPES.map((t) => t.id);
  const typeLabel = (id) => TYPES.find((t) => t.id === id)?.label || 'Unknown';
  const typeGlyph = (id) => TYPES.find((t) => t.id === id)?.glyph || '•';

  const UNIDENTIFIED = 'Unidentified';

  const byId = (list) => new Map((list || []).map((x) => [x.id, x]));

  /**
   * What to call an observation.
   *
   * Unidentified until a species is linked. Once linked, the species' common
   * name — with a question mark when the identification was only a guess, so a
   * low-confidence call can never be mistaken for a settled one at a glance.
   */
  function displayName(obs, species) {
    if (!species) return UNIDENTIFIED;
    const base = species.commonName || species.scientificName || UNIDENTIFIED;
    return obs.confidence === 'low' ? `${base}?` : base;
  }

  /**
   * An observation with its species resolved and its name derived — the shape
   * every view actually wants. Type follows the species when there is one: a
   * find cannot be Flora while pointing at a fungus.
   */
  function view(obs, speciesIndex) {
    const species = obs.speciesId ? speciesIndex.get(obs.speciesId) || null : null;
    return {
      ...obs,
      species,
      // A dangling speciesId (the species was deleted) reads as unidentified
      // rather than crashing the row.
      identified: !!species,
      uncertain: !!species && obs.confidence === 'low',
      type: species ? species.kind : obs.type,
      name: displayName(obs, species),
      scientificName: species ? species.scientificName || '' : '',
      when: obs.observedAt || null,
      hasPlace: Number.isFinite(obs.lat) && Number.isFinite(obs.lon),
    };
  }

  const viewAll = (observations, species) => {
    const index = byId(species);
    return (observations || []).map((o) => view(o, index));
  };

  // --- summary --------------------------------------------------------------

  function summary(rows) {
    const counts = Object.fromEntries(TYPE_IDS.map((t) => [t, 0]));
    let identified = 0, uncertain = 0, placed = 0;
    const speciesSeen = new Set();
    for (const r of rows) {
      if (counts[r.type] !== undefined) counts[r.type] += 1;
      if (r.identified) { identified += 1; speciesSeen.add(r.species.id); }
      if (r.uncertain) uncertain += 1;
      if (r.hasPlace) placed += 1;
    }
    const total = rows.length;
    return {
      total,
      counts,
      identified,
      unidentified: total - identified,
      uncertain,
      placed,
      // Species actually *found*, not species on file. A species record with no
      // observation behind it is a note, not a sighting.
      speciesSeen: speciesSeen.size,
      identifiedShare: total ? identified / total : 0,
      latest: latestOf(rows),
    };
  }

  /** The most recent find by observation date, falling back to entry order. */
  function latestOf(rows) {
    let best = null;
    for (const r of rows) {
      if (!r.when) continue;
      if (!best || r.when > best.when) best = r;
    }
    return best || rows[rows.length - 1] || null;
  }

  // --- life list ------------------------------------------------------------

  /**
   * Every species with how often it has turned up and when it was first found.
   * Species with no observations are kept, at zero: the library doubles as a
   * place to write up something read about but not yet met.
   */
  function lifeList(species, rows) {
    const tally = new Map();
    for (const r of rows) {
      if (!r.identified) continue;
      const entry = tally.get(r.species.id) || { count: 0, first: null, last: null, uncertain: 0 };
      entry.count += 1;
      if (r.uncertain) entry.uncertain += 1;
      if (r.when) {
        if (!entry.first || r.when < entry.first) entry.first = r.when;
        if (!entry.last || r.when > entry.last) entry.last = r.when;
      }
      tally.set(r.species.id, entry);
    }
    return (species || []).map((sp) => {
      const t = tally.get(sp.id) || { count: 0, first: null, last: null, uncertain: 0 };
      return { ...sp, ...t, seen: t.count > 0 };
    });
  }

  // --- filtering and sorting -----------------------------------------------

  /**
   * `status` narrows to how settled the identification is, which is the cut
   * that actually gets used: the unidentified pile is the to-do list, and the
   * uncertain pile is what to re-check against a key.
   */
  function filter(rows, f) {
    return rows.filter((r) => {
      // `types` is the set that is checked. Absent means no filtering; empty
      // means nothing is checked, which shows nothing rather than everything —
      // unchecking the last box should not silently mean "all".
      if (f.types && !f.types.includes(r.type)) return false;
      if (f.status === 'identified' && !r.identified) return false;
      if (f.status === 'unidentified' && r.identified) return false;
      if (f.status === 'uncertain' && !r.uncertain) return false;
      if (f.speciesId && r.species?.id !== f.speciesId) return false;
      // `edibility` mirrors `types`: absent means no filtering, empty means
      // nothing is checked and so nothing shows.
      if (f.edibility && !f.edibility.includes(findEdibility(r))) return false;
      if (f.q) {
        const hay = [r.name, r.scientificName, r.notes, r.place, typeLabel(r.type)]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(f.q.toLowerCase())) return false;
      }
      return true;
    });
  }

  /**
   * Newest first. Undated finds sort to the end rather than to 1970: an
   * observation with no date is unfinished, not ancient.
   */
  function sortByDate(rows, dir = 'desc') {
    const sign = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (!a.when && !b.when) return 0;
      if (!a.when) return 1;
      if (!b.when) return -1;
      return sign * (a.when < b.when ? -1 : a.when > b.when ? 1 : 0);
    });
  }

  // --- seasonality ----------------------------------------------------------


  // --- tags -----------------------------------------------------------------

  /*
   * Characters are tagged, not written out.
   *
   * Prose cannot be queried: "Neither gills nor pores" contains the word
   * "pores", so a search for pores returned the one mushroom that most
   * definitely has none. A tag is a thing you either have or you do not.
   *
   * Every tag carries a category, which is what gives it its colour. The
   * category is guessed from the vocabulary below and can be corrected by
   * clicking the tag, so the guess is a convenience and never a cage.
   */
  const TAG_CATEGORIES = [
    { id: 'form', label: 'Form', hint: 'The structure itself — gills, pores, a ring, a volva.' },
    { id: 'colour', label: 'Colour', hint: 'Shown with a swatch of the colour named.' },
    { id: 'descriptor', label: 'Descriptor', hint: 'A quality — adnate, viscid, crowded, bitter.' },
    { id: 'habitat', label: 'Habitat', hint: 'What it grows on or with — a tree, wood, soil, dung.' },
    { id: 'measure', label: 'Measure', hint: 'A size or a count.' },
    { id: 'note', label: 'Note', hint: 'Anything the vocabulary does not know.' },
  ];
  const tagCategory = (id) => TAG_CATEGORIES.find((c) => c.id === id) || TAG_CATEGORIES[TAG_CATEGORIES.length - 1];

  /*
   * Named colours, with a swatch each. Mycological colour language is its own
   * dialect — "buff", "ochre", "cinnamon", "tawny" — and a tag that renders
   * the colour it names is worth more than the same word in grey.
   */
  const COLOURS = {
    white: '#f2f0e9', cream: '#f0e6c8', ivory: '#efe7d2', buff: '#e8d8b0', straw: '#e6d78c',
    yellow: '#e8c840', 'egg-yellow': '#f0c850', gold: '#d9b038', ochre: '#c8963c', mustard: '#c9a227',
    apricot: '#f0a860', orange: '#e08840', tawny: '#c07838', salmon: '#e89878', peach: '#f0b48c',
    pink: '#e0a0a8', red: '#c04038', scarlet: '#cc3322', 'red-brown': '#8c4a30', rust: '#a85830',
    cinnamon: '#a06840', tan: '#c8a878', brown: '#7a5230', 'dark-brown': '#4a3020', umber: '#5b4636',
    olive: '#7a7a38', green: '#5a8848', 'blue-green': '#4a8878', verdigris: '#4f8f7a',
    grey: '#8a8a8a', 'blue-grey': '#7c8b99', blue: '#5a80b0', lilac: '#a890c0', purple: '#7a5090',
    violet: '#6a4a90', black: '#1a1a1a', 'flesh-pink': '#e4bfae', ferruginous: '#9c5220',
    /*
     * Hedged colours, which field guides use constantly and standing alone:
     * "cap whitish", not "cap whitish something". They were the single largest
     * gap in the vocabulary — 96 uses across one guide — because the modifier
     * rule below only fires when a base colour follows. Muted renderings of
     * their base, since that is what the words mean.
     */
    whitish: '#e8e6df', yellowish: '#d8c66a', brownish: '#8a6b4a', reddish: '#b05a4a',
    greyish: '#9a9a9a', pinkish: '#d8b0b0', greenish: '#7a9a68', blackish: '#2e2e2e',
    purplish: '#8a6a9a', orangish: '#d9964f',
  };

  // Modifiers that may precede a colour and still leave it a colour.
  const COLOUR_MODIFIERS = new Set([
    'pale', 'dark', 'deep', 'bright', 'dull', 'light', 'faint', 'rich', 'dusky', 'olivaceous',
    'greyish', 'brownish', 'yellowish', 'reddish', 'pinkish', 'greenish', 'blackish', 'whitish',
    'purplish', 'orangish', 'creamy', 'golden', 'wine',
  ]);

  const FORMS = new Set([
    'gills', 'false gills', 'pores', 'teeth', 'spines', 'ridges', 'folds', 'wrinkles', 'gleba',
    'maze-like', 'tubes', 'lamellae', 'cap', 'bracket', 'crust', 'cup', 'club', 'coral', 'puffball',
    'stipe', 'ring', 'annulus', 'volva', 'cortina', 'partial veil', 'universal veil', 'veil',
    'scabers', 'reticulation', 'basal bulb', 'rhizomorphs', 'latex', 'spore print',
    // Whole-fruit-body forms, for the `body` character. Both the plain words
    // and the technical ones, because guides use both freely.
    'agaricoid', 'gilled', 'boletoid', 'polypore', 'polyporoid', 'resupinate',
    'clavarioid', 'hydnoid', 'gasteroid', 'pezizoid', 'cantharelloid',
    'earthstar', 'earthball', 'stinkhorn', 'truffle', 'jelly', 'toothed',
    'morel', 'false morel', 'saddle', 'trumpet', 'fan',
    // Bird's-nest fungi. They look like tiny cups and are not remotely related
    // to the cup fungi, so they need a form of their own — without one they
    // were being tagged `cup` and matching pezizoid ascomycetes.
    'nidulariaceous', "bird's nest", 'birds nest', 'peridiole',
  ]);

  const DESCRIPTORS = new Set([
    // attachment
    'adnate', 'adnexed', 'decurrent', 'subdecurrent', 'free', 'sinuate', 'emarginate',
    // spacing and edge
    'crowded', 'close', 'distant', 'subdistant', 'forking', 'branching', 'serrate', 'entire', 'eroded',
    // surface
    'viscid', 'dry', 'moist', 'velvety', 'tomentose', 'fibrillose', 'scaly', 'smooth', 'glabrous',
    'zonate', 'concentric', 'hygrophanous', 'striate', 'reticulate', 'pruinose', 'waxy', 'slimy',
    // shape
    'convex', 'plane', 'flat', 'depressed', 'infundibuliform', 'umbonate', 'campanulate', 'conical',
    'ovoid', 'spherical', 'irregular', 'lobed', 'fan-shaped', 'kidney-shaped',
    // margin
    'inrolled', 'incurved', 'wavy', 'split', 'undulating', 'crenulate',
    // stipe
    'bulbous', 'equal', 'tapering', 'clavate', 'hollow', 'stuffed', 'solid', 'fibrous', 'brittle',
    'eccentric', 'lateral', 'central', 'sessile', 'rooting',
    // flesh and texture
    'fleshy', 'leathery', 'corky', 'gelatinous', 'tough', 'soft',
    // staining
    'bruises blue', 'bruises brown', 'bruises red', 'bruises black', 'bruises yellow',
    'unchanging', 'slowly', 'immediately',
    // scent and taste
    'mild', 'bitter', 'acrid', 'peppery', 'farinaceous', 'mealy', 'anise', 'almond', 'radish',
    'phenolic', 'sweet', 'fruity', 'fishy', 'garlic', 'rancid', 'sour', 'nutty', 'earthy',
    // habit
    'clustered', 'scattered', 'solitary', 'troops', 'fairy ring', 'caespitose',
  ]);

  const HABITATS = new Set([
    // what it sits on
    'soil', 'duff', 'litter', 'leaf litter', 'moss', 'wood', 'dead wood', 'dead hardwood',
    'rotten wood', 'stump', 'log', 'fallen branches', 'living tree', 'buried wood', 'woodchips',
    'dung', 'burn site', 'grass', 'lawn', 'sand', 'bog',
    // Two substrates that are neither soil nor wood. `fungus` covers the
    // mycoparasites — Hypomyces on a russula, Asterophora on a blackened
    // Russula — and `keratin` the hair, wool, feathers and owl pellets that
    // Onygena lives on. Both were homeless, and both are whole niches.
    'fungus', 'keratin',
    // what it grows with
    'conifer', 'hardwood', 'broadleaf', 'mixed woodland',
    'douglas fir', 'western hemlock', 'sitka spruce', 'western red cedar', 'grand fir',
    'shore pine', 'lodgepole pine', 'ponderosa pine', 'spruce', 'pine', 'fir', 'hemlock', 'cedar',
    'oak', 'garry oak', 'alder', 'red alder', 'big-leaf maple', 'vine maple', 'maple', 'birch',
    'cottonwood', 'willow', 'madrone', 'cherry', 'beech', 'chestnut', 'hornbeam', 'poplar', 'aspen',
    // Understory, not canopy. Salal turned up twice — once from the field
    // guide pass and once from a find logged in the app.
    'salal',
  ]);

  /*
   * Categories set by hand in the glossary.
   *
   * A term's category is a property of the term, not of one usage of it — if
   * `angular` describes a gill edge, it describes one everywhere. So the
   * override lives here, keyed on the term, and beats whatever the vocabulary
   * would have guessed. The glossary view is where they are set.
   */
  const termOverrides = new Map();

  /*
   * Terms that mean the same thing, set by hand in the glossary.
   *
   * `ridges` and `false gills` are one character of one mushroom described two
   * ways, and a key that treats them as different terms fails to match a
   * chanterelle against itself. Keyed term -> canonical term; matching
   * compares canonical forms, so either spelling of an idea finds the other.
   */
  const termSynonyms = new Map();

  const applyGlossary = (glossary) => {
    termOverrides.clear();
    termSynonyms.clear();
    for (const [term, entry] of Object.entries(glossary?.terms || {})) {
      const key = normalizeTag(term);
      if (entry?.category) termOverrides.set(key, entry.category);
      if (entry?.sameAs) termSynonyms.set(key, normalizeTag(entry.sameAs));
    }
  };

  /**
   * Lower-cased, collapsed whitespace. The form every lookup is keyed on.
   *
   * American "gray" folds to British "grey". Duplicating every grey entry in
   * the tables was the alternative, and duplicated tables drift — one spelling
   * gets a new shade and the other does not. Folding here also means a
   * specimen tagged "gray" matches a species recorded as "grey", which is the
   * behaviour anyone would expect of two spellings of one word.
   */
  const normalizeTag = (text) =>
    String(text || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/\bgray/g, 'grey');

  /**
   * Guess what kind of thing a tag is.
   *
   * Exact vocabulary matches win first, so "bruises blue" stays a descriptor
   * rather than being read as the colour blue. Only then does the trailing-word
   * rule run, which is what lets "pale yellow" and "olive-brown" colour
   * themselves without every shade being listed.
   */
  function classifyTag(text, spec, { ignoreOverrides = false } = {}) {
    const key = normalizeTag(text);
    if (!key) return 'note';
    // A category set by hand outranks everything, including the per-character
    // rules below: it was a decision, not a guess.
    if (!ignoreOverrides && termOverrides.has(key)) return termOverrides.get(key);
    let found = null;

    if (COLOURS[key]) found = 'colour';
    else if (FORMS.has(key)) found = 'form';
    else if (DESCRIPTORS.has(key)) found = 'descriptor';
    else if (HABITATS.has(key)) found = 'habitat';
    else {
      const words = key.split(/[\s-]+/);
      const last = words[words.length - 1];
      // "pale yellow", "dark olive" — a colour with something in front of it.
      if (COLOURS[last] && words.slice(0, -1).every((w) => COLOUR_MODIFIERS.has(w) || COLOURS[w])) found = 'colour';
      else if (/\d/.test(key)) found = 'measure';
      else found = 'note';
    }

    // Under "scent / taste", apricot is a smell, not a colour. A few words mean
    // different things depending on the character they sit under, and the
    // character is the only context available to tell them apart.
    if (spec && found === 'colour' && spec.colourAs) return spec.colourAs;

    // Anything the vocabulary does not know stays a note, deliberately. It
    // would be easy to guess from the character it was typed into — an
    // unlisted tree under "associated trees" is almost certainly a tree — but
    // a guess that always looks right is a guess nobody ever checks. Leaving
    // it dashed and grey is what makes the gaps in the vocabulary visible,
    // which is the only way the vocabulary gets better.
    return found;
  }

  /** What the vocabulary would say, ignoring any category set by hand. */
  const guessCategory = (text, spec) => classifyTag(text, spec, { ignoreOverrides: true });

  /** The swatch a colour tag paints, or null. */
  function tagSwatch(text) {
    const key = normalizeTag(text);
    if (COLOURS[key]) return COLOURS[key];
    const words = key.split(/[\s-]+/);
    return COLOURS[words[words.length - 1]] || null;
  }

  // --- fungal characters ----------------------------------------------------

  /*
   * The characters a key walks, in roughly the order it walks them. Each
   * carries its own suggestion list; the colours are offered everywhere,
   * because almost any of these can be described by colour.
   */
  const FUNGI_CHARACTERS = [
    /*
     * The whole fruit body, before any of its parts.
     *
     * Added because the parts could not hold it. Once a cup fungus correctly
     * marks `cap` and `hymenium` absent, its defining feature — a brilliant
     * orange cup — has nowhere left to live, and the growth form that made
     * those absences predictable is likewise homeless. This character holds
     * both: what shape the thing is, and what colour it is overall.
     *
     * It is the one character that can never be absent. If you are holding a
     * specimen it has a fruit body, so the N/A tick is suppressed rather than
     * offered and left meaninglessly unticked.
     */
    { id: 'body', label: 'Fruit body', absent: 'No fruit body', alwaysPresent: true,
      vocab: ['agaricoid', 'gilled', 'boletoid', 'bracket', 'polypore', 'crust', 'resupinate',
        'cup', 'club', 'coral', 'fan', 'puffball', 'earthstar', 'earthball', 'stinkhorn',
        'truffle', 'jelly', 'toothed', 'morel', 'false morel', 'saddle', 'trumpet',
        'nidulariaceous', "bird's nest"] },
    { id: 'cap', label: 'Cap', absent: 'No distinct cap',
      vocab: ['cap', 'bracket', 'crust', 'convex', 'plane', 'depressed', 'umbonate', 'campanulate', 'conical', 'viscid', 'dry', 'velvety', 'scaly', 'zonate', 'striate', 'hygrophanous', 'inrolled', 'wavy', 'split'] },
    { id: 'hymenium', label: 'Gills / pores', absent: 'Neither gills nor pores',
      vocab: ['gills', 'false gills', 'pores', 'teeth', 'ridges', 'folds', 'tubes', 'gleba', 'maze-like', 'smooth', 'adnate', 'adnexed', 'decurrent', 'free', 'sinuate', 'crowded', 'close', 'distant', 'forking', 'waxy'] },
    { id: 'stipe', label: 'Stipe', absent: 'Sessile — no stipe',
      vocab: ['stipe', 'ring', 'annulus', 'volva', 'cortina', 'basal bulb', 'scabers', 'reticulation', 'equal', 'tapering', 'clavate', 'bulbous', 'hollow', 'stuffed', 'solid', 'fibrous', 'eccentric', 'lateral', 'sessile'] },
    { id: 'sporePrint', label: 'Spore colour', absent: 'No print obtainable',
      vocab: ['white', 'cream', 'buff', 'pink', 'ochre', 'rust', 'cinnamon', 'brown', 'dark-brown', 'purple', 'black', 'yellow'] },
    { id: 'scent', label: 'Scent / taste', absent: 'Nothing distinctive', colourAs: 'descriptor',
      vocab: ['mild', 'bitter', 'acrid', 'peppery', 'farinaceous', 'anise', 'almond', 'radish', 'phenolic', 'sweet', 'fruity', 'apricot', 'fishy', 'garlic', 'rancid', 'earthy', 'nutty'] },
    { id: 'staining', label: 'Staining', absent: 'Does not stain',
      vocab: ['bruises blue', 'bruises brown', 'bruises red', 'bruises black', 'bruises yellow', 'unchanging', 'slowly', 'immediately', 'latex'] },
    { id: 'substrate', label: 'Substrate', absent: 'No consistent substrate',
      vocab: ['soil', 'duff', 'leaf litter', 'moss', 'wood', 'dead wood', 'dead hardwood', 'rotten wood', 'stump', 'log', 'fallen branches', 'living tree', 'buried wood', 'woodchips', 'dung', 'burn site', 'grass', 'fungus', 'keratin'] },
    { id: 'trees', label: 'Associated trees', absent: 'Not tree-associated',
      vocab: ['douglas fir', 'western hemlock', 'sitka spruce', 'western red cedar', 'grand fir', 'shore pine', 'oak', 'garry oak', 'red alder', 'big-leaf maple', 'vine maple', 'birch', 'cottonwood', 'madrone', 'conifer', 'hardwood', 'mixed woodland'] },
  ];

  /** Suggestions for one character: its own vocabulary, then every colour. */
  function characterVocab(spec) {
    const seen = new Set(spec.vocab);
    return [...spec.vocab, ...Object.keys(COLOURS).filter((c) => !seen.has(c))];
  }

  /*
   * How it feeds. `parasitic` covers living at another organism's expense —
   * Cordyceps on truffles, Tremella on other fungi, Caloscypha on conifer
   * seeds. It was added after three independent species in one pass had to be
   * left "not recorded" for want of it, which is the wrong answer three times.
   */
  const NUTRITION = [
    { id: 'unknown', label: 'Not recorded' },
    { id: 'saprophytic', label: 'Saprophytic' },
    { id: 'mycorrhizal', label: 'Mycorrhizal' },
    { id: 'parasitic', label: 'Parasitic' },
    // Named before there was a third mode; it still means the first two.
    { id: 'both', label: 'Saprophytic and mycorrhizal' },
  ];
  const nutrition = (id) => NUTRITION.find((n) => n.id === (id || 'unknown')) || NUTRITION[0];

  /** A stored tag, in the shape the views want. */
  const readTag = (raw, spec) => {
    if (typeof raw === 'string') return { text: raw.trim(), category: classifyTag(raw, spec) };
    const text = String(raw?.text || '').trim();
    // A stored category is honoured even when the vocabulary disagrees: it was
    // set by hand, and the vocabulary is only ever a guess.
    return { text, category: raw?.category || classifyTag(text, spec) };
  };

  const characterSpec = (id) => FUNGI_CHARACTERS.find((c) => c.id === id) || null;

  /**
   * One character, in three states that must never collapse into each other:
   *
   *   absent      — this species has no such structure. A real claim.
   *   recorded    — one or more tags.
   *   unrecorded  — nobody has written it down yet.
   *
   * The middle distinction is the whole point. "No gills" sends you down one
   * half of a key; "gills not noted" sends you nowhere.
   */
  function character(sp, id) {
    const raw = sp?.characters?.[id];
    const spec = characterSpec(id);

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.na) return { na: true, tags: [], state: 'absent' };
      const tags = (Array.isArray(raw.tags) ? raw.tags : splitToTags(raw.text)).map((t) => readTag(t, spec)).filter((t) => t.text);
      return { na: false, tags, state: tags.length ? 'recorded' : 'unrecorded' };
    }
    // Free text, from before the characters were tagged, or hand-edited in.
    if (typeof raw === 'string' || Array.isArray(raw)) {
      const tags = (Array.isArray(raw) ? raw : splitToTags(raw)).map((t) => readTag(t, spec)).filter((t) => t.text);
      return { na: false, tags, state: tags.length ? 'recorded' : 'unrecorded' };
    }
    // Older still: two tri-states, before there were characters at all.
    const legacy = id === 'hymenium' ? sp?.gills : id === 'stipe' ? sp?.stipe : null;
    if (legacy === 'no') return { na: true, tags: [], state: 'absent' };
    if (legacy === 'yes') {
      const text = id === 'stipe' ? 'stipe' : 'gills';
      return { na: false, tags: [readTag(text, spec)], state: 'recorded' };
    }
    return { na: false, tags: [], state: 'unrecorded' };
  }

  /** Prose into tags, on the clause boundaries people actually type. */
  const splitToTags = (text) =>
    String(text || '').split(/[,;·]|\s+—\s+/).map((part) => part.trim()).filter(Boolean);

  /** How a character reads once written down. Empty for one never recorded. */
  function characterValue(sp, spec) {
    const c = character(sp, spec.id);
    if (c.state === 'absent') return spec.absent;
    return c.tags.map((t) => t.text).join(', ');
  }

  /** Everything said about a fungus, for a summary. Silent on what is unsaid. */
  function fungiTraits(sp) {
    if (!sp || sp.kind !== 'fungi') return [];
    const out = [];
    for (const spec of FUNGI_CHARACTERS) {
      const c = character(sp, spec.id);
      if (c.state === 'unrecorded') continue;
      out.push({
        label: spec.label,
        value: c.state === 'absent' ? spec.absent : c.tags.map((t) => t.text).join(', '),
        tags: c.tags,
        absent: c.state === 'absent',
      });
    }
    /*
     * Division and nutrition come after the characters, not before them.
     * The find sheet shows this list beside what you tagged on the find, and
     * both lists walk FUNGI_CHARACTERS in the same order \u2014 so anything put in
     * front of them offsets the two columns and the rows stop lining up.
     */
    if (sp.division) out.push({ label: 'Division', value: sp.division, tags: [] });
    if (sp.nutrition && sp.nutrition !== 'unknown') out.push({ label: 'Nutrition', value: nutrition(sp.nutrition).label, tags: [] });
    return out;
  }

  /**
   * Every scientific name that means this organism.
   *
   * Three sources, and the distinction between them is worth keeping. The
   * `scientificName` is what this library calls it. `synonyms` are other
   * *current* names for the same thing — a field guide and iNaturalist can
   * simply disagree, as they do over the western matsutake, which the guide
   * files under Tricholoma magnivelare and iNaturalist under T. murrillianum.
   * `formerNames` are names it has been retired from. All three are worth
   * searching, because records exist under all three.
   */
  function speciesNames(sp) {
    const seen = new Set();
    const out = [];
    for (const n of [sp?.scientificName, ...(sp?.synonyms || []), ...(sp?.formerNames || [])]) {
      const name = String(n || '').trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  /**
   * Everything about a species that a search box should match.
   *
   * Tags only — the wording for an absence is deliberately left out. It was
   * the old prose that made a search for "pores" return the chanterelle, whose
   * record says it has none of them.
   */
  function speciesText(sp) {
    const tags = FUNGI_CHARACTERS.flatMap((spec) => character(sp, spec.id).tags.map((t) => t.text));
    return [
      sp.commonName, sp.scientificName, sp.habitat, sp.division, sp.lookalikes,
      ...(sp.synonyms || []),
      edibility(sp.edibility).label,
      sp.nutrition && sp.nutrition !== 'unknown' ? nutrition(sp.nutrition).label : null,
      ...tags,
      ...(sp.formerNames || []),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  /*
   * Growth forms that mean the same thing.
   *
   * A body form is categorical in a way no other character is: a bracket is
   * not a coral, and no amount of variation closes that gap. That makes it the
   * one character where a mismatch can rule a species out rather than merely
   * fail to match it.
   *
   * Which puts all the weight on synonyms. Guides say "bracket", "polypore"
   * and "polyporoid" for one thing; a key that ruled out a species because the
   * observer wrote one and the library held another would be worse than no key
   * at all. So the comparison runs on these groups, never on the words.
   *
   * Anything absent from this table resolves to null and can never contradict.
   * That is the safe default and it is why genuinely ambiguous terms — `fan`,
   * which covers both bracket-like and crust-like fungi — are left out on
   * purpose rather than forced into a group.
   */
  const BODY_GROUPS = {
    agaricoid: 'agaricoid', gilled: 'agaricoid',
    boletoid: 'boletoid',
    polyporoid: 'polyporoid', polypore: 'polyporoid', bracket: 'polyporoid',
    corticioid: 'corticioid', crust: 'corticioid', resupinate: 'corticioid',
    hydnoid: 'hydnoid', toothed: 'hydnoid',
    clavarioid: 'clavarioid', coral: 'clavarioid', club: 'clavarioid',
    gasteroid: 'gasteroid', puffball: 'gasteroid', earthball: 'gasteroid', earthstar: 'gasteroid',
    pezizoid: 'pezizoid', cup: 'pezizoid',
    morchelloid: 'morchelloid', morel: 'morchelloid',
    helvelloid: 'helvelloid', saddle: 'helvelloid', 'false morel': 'helvelloid',
    cantharelloid: 'cantharelloid', trumpet: 'cantharelloid',
    gelatinous: 'gelatinous', jelly: 'gelatinous',
    nidulariaceous: 'nidulariaceous', "bird's nest": 'nidulariaceous', 'birds nest': 'nidulariaceous',
    stinkhorn: 'stinkhorn',
    truffle: 'truffle',
  };
  const bodyGroup = (text) => BODY_GROUPS[normalizeTag(text)] || null;

  /*
   * Every growth form the groups know is a form word, by construction.
   *
   * These two tables were maintained by hand and drifted: `morchelloid`,
   * `helvelloid`, `corticioid` and `gelatinous` were group keys but never
   * FORMS entries, so they classified as `note` — and because the contradiction
   * check only reads tags categorised `form`, the morels quietly stopped ruling
   * anything out. Deriving one from the other means that cannot recur.
   */
  for (const form of Object.keys(BODY_GROUPS)) FORMS.add(form);

  /**
   * Terms this app treats as the same thing, for a given term.
   *
   * Two kinds. Growth forms share a synonym group, so `bracket`, `polypore`
   * and `polyporoid` are one form as far as ruling a species out goes. And
   * `gray` folds to `grey` everywhere, so the two spellings are one tag.
   */
  function synonymsOf(text, knownTerms) {
    const key = normalizeTag(text);
    const group = termGroup(key);
    const out = new Set();

    // Growth-form groups.
    for (const [term, g] of Object.entries(BODY_GROUPS)) if (g === group && term !== key) out.add(term);
    // Anything pointed at the same canonical form by hand, in either direction.
    for (const term of new Set([...termSynonyms.keys(), ...(knownTerms || [])])) {
      if (term !== key && termGroup(term) === group) out.add(term);
    }
    if (/grey/.test(key)) out.add(key.replace(/grey/g, 'gray'));
    return [...out].sort();
  }

  /**
   * The canonical form of a tag, for comparison.
   *
   * Three layers: a synonym set by hand in the glossary wins, then the
   * growth-form groups (so `bracket` and `polypore` are one thing), then the
   * term itself. Everything that compares tags compares these, which is what
   * makes two words for one idea behave as one.
   */
  function termGroup(text) {
    const key = normalizeTag(text);
    const named = termSynonyms.get(key);
    if (named) return termSynonyms.get(named) || BODY_GROUPS[named] || named;
    return BODY_GROUPS[key] || key;
  }

  /**
   * Does an observed body form rule this species out?
   *
   * Only when both sides name a form the table knows, and the two sets of
   * groups do not overlap at all. Colour on the body character is ignored
   * here — an orange specimen of a species recorded as yellow is a variation,
   * not a different organism.
   */
  function bodyConflict(seenTags, knownTags) {
    const groupsOf = (tags) => new Set(
      tags.filter((t) => t.category === 'form').map((t) => bodyGroup(t.text)).filter(Boolean),
    );
    const seen = groupsOf(seenTags);
    const known = groupsOf(knownTags);
    if (!seen.size || !known.size) return null;
    if ([...seen].some((g) => known.has(g))) return null;
    return knownTags.filter((t) => t.category === 'form').map((t) => t.text).join(', ');
  }

  // --- identification -------------------------------------------------------

  /*
   * Matching a specimen against the library.
   *
   * An observation carries the characters you actually saw; a species carries
   * what the character is supposed to be. Comparing them is the whole of
   * identification, and the only subtle part is what counts as a "no".
   *
   * A species is ruled out only by contradiction — you saw gills, and its
   * record says it has none. A tag the species simply does not mention is NOT
   * evidence against it: the library is half-written, and a young log would
   * otherwise eliminate every correct answer for want of a note.
   */
  function matchSpecies(observation, species) {
    const matched = [];
    const conflicts = [];
    let unmatched = 0;
    let compared = 0;

    for (const spec of FUNGI_CHARACTERS) {
      const seen = character(observation, spec.id).tags;
      if (!seen.length) continue;
      const known = character(species, spec.id);

      // The fruit body is the one character that can rule a species out by
      // disagreeing rather than by being recorded absent.
      if (spec.id === 'body' && known.state === 'recorded') {
        const clash = bodyConflict(seen, known.tags);
        if (clash) {
          for (const tag of seen.filter((t) => t.category === 'form')) {
            conflicts.push({ character: spec, tag, reason: clash });
          }
        }
      }

      if (known.state === 'absent') {
        // The specimen has a structure the species is recorded as lacking.
        for (const tag of seen) conflicts.push({ character: spec, tag, reason: spec.absent });
        compared += 1;
        continue;
      }
      if (known.state === 'unrecorded') continue;

      compared += 1;
      // Canonical forms, so `ridges` on the specimen matches `false gills` in
      // the library rather than counting as a miss.
      const have = new Set(known.tags.map((t) => termGroup(t.text)));
      for (const tag of seen) {
        if (have.has(termGroup(tag.text))) matched.push({ character: spec, tag });
        else unmatched += 1;
      }
    }

    return {
      species,
      matched,
      conflicts,
      unmatched,
      compared,
      score: matched.length,
      contradicted: conflicts.length > 0,
    };
  }

  /** How many character tags an observation carries. */
  const observedTagCount = (observation) =>
    FUNGI_CHARACTERS.reduce((n, spec) => n + character(observation, spec.id).tags.length, 0);

  /**
   * The library, narrowed and ranked against what was seen.
   *
   * Contradicted species are kept rather than dropped — a contradiction is
   * usually right, but it can also mean the specimen was misread or the
   * library is wrong, and silently hiding the answer helps nobody. They sort
   * to the bottom and say why.
   */
  function rankCandidates(observation, speciesList, { type } = {}) {
    const kind = type || observation.type;
    const pool = (speciesList || []).filter((sp) => !kind || sp.kind === kind);
    const anyTags = observedTagCount(observation) > 0;

    const rows = pool.map((sp) => matchSpecies(observation, sp));
    rows.sort((a, b) => {
      if (a.contradicted !== b.contradicted) return a.contradicted ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      if (a.unmatched !== b.unmatched) return a.unmatched - b.unmatched;
      return String(a.species.commonName || a.species.scientificName || '')
        .localeCompare(String(b.species.commonName || b.species.scientificName || ''));
    });

    return { rows, anyTags, pool: pool.length };
  }

  // --- edibility ------------------------------------------------------------

  /*
   * A scale, not a flag.
   *
   * "Choice edible" is the thing worth marking, but a field that can only say
   * "good to eat" or "not recorded" is the wrong shape for this subject: the
   * records you most need to be unambiguous are the ones that will hurt you.
   * Ordered from the kitchen to the morgue so a sort puts the dangerous end
   * where it can be seen.
   */
  const EDIBILITY = [
    { id: 'unknown', label: 'Not recorded', short: '—', rank: 0 },
    { id: 'choice', label: 'Choice edible', short: 'Choice', rank: 1 },
    { id: 'edible', label: 'Edible', short: 'Edible', rank: 2 },
    { id: 'inedible', label: 'Inedible', short: 'Inedible', rank: 3 },
    // Between "not worth eating" and "will hurt you": eaten by some people,
    // and it disagrees with others. Ranked above inedible because inedible is
    // merely unpalatable, while this one carries actual risk — and recorded
    // rather than rounded off, because "some people do" is the fact worth
    // keeping about it.
    { id: 'dubious', label: 'Dubious', short: 'Dubious', rank: 4 },
    { id: 'toxic', label: 'Toxic', short: 'Toxic', rank: 5 },
    { id: 'deadly', label: 'Deadly', short: 'Deadly', rank: 6 },
  ];
  const edibility = (id) => EDIBILITY.find((e) => e.id === (id || 'unknown')) || EDIBILITY[0];
  const EDIBILITY_IDS = EDIBILITY.map((e) => e.id);
  const isChoice = (sp) => sp?.edibility === 'choice';
  // Eaten by some, tolerated by not everyone. Its own mark, because rounding it
  // into either neighbour loses the only thing it says.
  const isDubious = (sp) => sp?.edibility === 'dubious';
  // Anything that should stop a forager's hand, for the one badge that has to
  // be impossible to miss.
  const isDangerous = (sp) => sp?.edibility === 'toxic' || sp?.edibility === 'deadly';

  /*
   * A find's tier is its species' tier, and a find with no species is
   * `unknown` \u2014 an unidentified mushroom is not edible-unless-proven, it is
   * simply not yet known. That also keeps the tiers summing to the total, so
   * the counts in the filter add up to the number of finds.
   */
  const findEdibility = (r) => r.species?.edibility || 'unknown';

  function edibilityCounts(rows) {
    const counts = {};
    for (const e of EDIBILITY) counts[e.id] = 0;
    for (const r of rows) counts[findEdibility(r)] = (counts[findEdibility(r)] || 0) + 1;
    return counts;
  }

  /**
   * How strongly to draw a record of a given age.
   *
   * A sighting from last week tells you where to look this weekend; one from
   * six years ago still tells you the species lives there. Both are worth
   * having, so the scale fades but never reaches nothing \u2014 a pin you cannot
   * see is a pin that is not on the map.
   *
   * Full for the past month, then a quarter down per year: 0.75 under a year,
   * 0.50 in the second, and a floor from two years on.
   */
  const AGE_FULL = 1;
  const AGE_STEP = 0.25;
  const AGE_FLOOR = 0.25;
  const AGE_FRESH_DAYS = 31;

  function ageOpacity(when, now = Date.now()) {
    const t = when ? Date.parse(when) : NaN;
    // An undated record is not an old one, it just has nothing to say about
    // its age. One step down says "unvouched" without claiming decades.
    if (!Number.isFinite(t)) return AGE_FULL - AGE_STEP;
    const days = (now - t) / 86400000;
    // A date in the future is a data error, not a fresh find; it reads as now.
    if (days <= AGE_FRESH_DAYS) return AGE_FULL;
    const years = Math.floor(days / 365.25);
    return Math.max(AGE_FLOOR, AGE_FULL - AGE_STEP * (years + 1));
  }

  // --- geography ------------------------------------------------------------

  const formatCoord = (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
    const fmt = (v, pos, neg) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? pos : neg}`;
    return `${fmt(lat, 'N', 'S')}, ${fmt(lon, 'E', 'W')}`;
  };

  // OpenStreetMap rather than an embedded basemap: tiles are a network
  // dependency, and this app is meant to work in a cabin with no signal.
  const mapLink = (lat, lon) =>
    Number.isFinite(lat) && Number.isFinite(lon)
      ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`
      : null;

  /**
   * A bounding box over every placed find, padded so points never sit on the
   * edge. Used to draw the little relative map — there is no basemap, so this
   * only ever shows finds against each other.
   */
  function bounds(rows) {
    const placed = rows.filter((r) => r.hasPlace);
    if (!placed.length) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const r of placed) {
      minLat = Math.min(minLat, r.lat); maxLat = Math.max(maxLat, r.lat);
      minLon = Math.min(minLon, r.lon); maxLon = Math.max(maxLon, r.lon);
    }
    // A single point, or a tight cluster, would give a zero-width box and
    // divide by zero when projecting. Floor the span instead.
    const padLat = Math.max((maxLat - minLat) * 0.12, 0.0015);
    const padLon = Math.max((maxLon - minLon) * 0.12, 0.0015);
    return { minLat: minLat - padLat, maxLat: maxLat + padLat, minLon: minLon - padLon, maxLon: maxLon + padLon, count: placed.length };
  }

  return {
    TYPES, TYPE_IDS, UNIDENTIFIED, EDIBILITY, EDIBILITY_IDS, FUNGI_CHARACTERS, NUTRITION,
    TAG_CATEGORIES, COLOURS,
    typeLabel, typeGlyph, edibility, isChoice, isDubious, isDangerous,
    findEdibility, edibilityCounts, ageOpacity,
    character, characterValue, characterVocab, nutrition, speciesText,
    matchSpecies, rankCandidates, observedTagCount,
    classifyTag, tagSwatch, tagCategory, normalizeTag, readTag, characterSpec,
    bodyGroup, bodyConflict, applyGlossary, synonymsOf, guessCategory, termGroup,
    byId, view, viewAll, displayName,
    summary, latestOf, lifeList,
    filter, sortByDate,
    fungiTraits, speciesNames, formatCoord, mapLink, bounds,
  };
})();

if (typeof module !== 'undefined') module.exports = Model;
