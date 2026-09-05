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
      // What is written on the record, else what the photographs said. Null when
      // neither has one, and the ground model fills that in later if it can.
      elevation: recordedElevation(obs) || photoElevation(obs),
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
    { id: 'measure', label: 'Measure', hint: 'A size, in whole centimetres — 20 cm.' },
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
    // growth habit
    'solitary', 'scattered', 'gregarious', 'clustered', 'caespitose', 'troops', 'tufted', 'fairy ring',
    // where the fruit body sits relative to the ground. Hypogeous is the
    // marked case — a mushroom you have to dig for, and the reason the
    // truffles never turn up in a search of what is visible.
    'hypogeous', 'epigeous', 'partially emergent',
    // flesh and texture
    'fleshy', 'leathery', 'corky', 'gelatinous', 'tough', 'soft',
    'rubbery', 'elastic', 'fragile',
    // surface, in the wet-to-dry order the keys use
    'glutinous', 'greasy', 'shiny',
    // stature and gill width — 'broad' is width, not the spacing that
    // crowded/close/distant already cover
    'slender', 'broad',
    // staining
    'bruises blue', 'bruises brown', 'bruises red', 'bruises black', 'bruises yellow',
    'bruises green', 'bruises purple', 'bruises orange', 'bruises pink',
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
      else if (parseMeasure(key)?.values.length) found = 'measure';
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

  // --- measures -------------------------------------------------------------

  /*
   * Size is a tag like any other, and unlike every other.
   *
   * Like the others because it lives under a character — the cap is 20 cm the
   * way the cap is convex — and is recorded on a find and on a species alike.
   * Unlike them because it is a number, and a number has no vocabulary: every
   * whole centimetre is a valid tag, so listing them would put two hundred
   * near-identical rows in the Glossary and offer them all in every popover.
   * A measure is therefore recognised by its shape rather than looked up, and
   * is kept out of the Glossary and the suggestions altogether.
   *
   * One unit, whole centimetres, under two metres. Guides give cap and stipe
   * in centimetres, finds get measured against a hand or a knife, and the
   * numbers have never needed more precision than that. Anything under a
   * centimetre rounds up to one rather than down to nothing, since a fungus
   * with a size has a size.
   *
   * On a find a measure is what you measured. On a species it is a range:
   * the smallest and largest measure tagged are the bounds, and a lone one is
   * a ceiling — which is how a guide's "cap to 8 cm" reads, and is what the
   * one-number tags written before this existed meant.
   *
   * Spore sizes are not measures. They are microns, they are a pair, and
   * nobody in the field has a microscope; "8–11 × 5–6 µm" does not parse and
   * stays a note.
   */
  const MEASURE_MAX_CM = 200;

  // "20", "20 cm", "20cm", "3-10 cm", "3–10 cm", "3 to 10 cm", "up to 20 cm",
  // "2.5 cm", "5 mm", "1.5 m". The whole string, or it is not a measure.
  const MEASURE = /^(?:up to|to|under|≤|<=)?\s*(\d+(?:[.,]\d+)?)\s*(?:(?:-|–|—|to)\s*(\d+(?:[.,]\d+)?))?\s*(cm|mm|m)?\.?$/;

  /**
   * The whole centimetres a piece of text names, or null when it names none.
   *
   * A range is two values, a single figure is one. Out of range is an answer
   * too — `{ values: [], error }` — so the field can say why it refused rather
   * than quietly filing "250 cm" as a note.
   */
  function parseMeasure(text) {
    const m = normalizeTag(text).match(MEASURE);
    if (!m) return null;
    const unit = m[3] || 'cm';
    const scale = unit === 'mm' ? 0.1 : unit === 'm' ? 100 : 1;
    const values = [m[1], m[2]].filter(Boolean)
      .map((v) => Math.max(1, Math.round(Number(v.replace(',', '.')) * scale)));
    if (values.some((v) => v >= MEASURE_MAX_CM)) {
      return { values: [], error: `Sizes are whole centimetres under ${MEASURE_MAX_CM} cm.` };
    }
    // Sorted, so "10–3 cm" is the same range as "3–10 cm"; deduplicated, so
    // "5–5 cm" is one tag.
    return { values: [...new Set(values)].sort((a, b) => a - b), error: null };
  }

  /** How a measure is written, everywhere. */
  const measureText = (cm) => `${cm} cm`;

  /** The centimetres a measure tag holds, or null for any other tag. */
  function measureOf(text) {
    const parsed = parseMeasure(text);
    return parsed && parsed.values.length === 1 ? parsed.values[0] : null;
  }

  /**
   * What a set of tags says about size, as a range.
   *
   * Two or more measures: the smallest and the largest, whatever else was
   * tagged between them. One measure: a ceiling — "cap to 8 cm" — with no
   * floor. None: null, which is "size not recorded" and matches nothing.
   */
  function measureRange(tags) {
    const cms = (tags || []).map((t) => measureOf(t.text)).filter((v) => v !== null);
    if (!cms.length) return null;
    const max = Math.max(...cms);
    const min = cms.length > 1 ? Math.min(...cms) : null;
    const text = min === null ? `to ${measureText(max)}` : min === max ? measureText(max) : `${min}–${measureText(max)}`;
    return { min, max, text };
  }

  /** Does a measured specimen fit a recorded range? Inclusive at both ends. */
  const withinRange = (cm, range) =>
    !!range && cm <= range.max && (range.min === null || cm >= range.min);

  /**
   * Tags as a reading surface shows them: the measures folded into one chip
   * that reads as the range, ahead of the words the way a guide leads with
   * the size. For species only — a find's two measures are two specimens,
   * not a range, and stay as they were tagged.
   */
  function displayTags(tags) {
    const range = measureRange(tags);
    if (!range) return tags;
    return [
      { text: range.text, category: 'measure', range },
      ...tags.filter((t) => measureOf(t.text) === null),
    ];
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
    { id: 'body', label: 'Fruit body', absent: 'No fruit body', alwaysPresent: true, measured: true,
      vocab: ['agaricoid', 'gilled', 'boletoid', 'bracket', 'polypore', 'crust', 'resupinate',
        'cup', 'club', 'coral', 'fan', 'puffball', 'earthstar', 'earthball', 'stinkhorn',
        'pleurotoid', 'collybioid',
        'truffle', 'jelly', 'toothed', 'morel', 'false morel', 'saddle', 'trumpet',
        'nidulariaceous', "bird's nest"] },
    { id: 'cap', label: 'Cap', absent: 'No distinct cap', measured: true,
      vocab: ['cap', 'bracket', 'crust', 'convex', 'plane', 'depressed', 'umbonate', 'campanulate', 'conical', 'glutinous', 'viscid', 'greasy', 'dry', 'shiny', 'velvety', 'scaly', 'zonate', 'striate', 'hygrophanous', 'inrolled', 'wavy', 'split'] },
    { id: 'hymenium', label: 'Gills / pores', absent: 'Neither gills nor pores',
      vocab: ['gills', 'false gills', 'pores', 'teeth', 'ridges', 'folds', 'tubes', 'gleba', 'maze-like', 'smooth', 'adnate', 'adnexed', 'decurrent', 'free', 'sinuate', 'crowded', 'close', 'distant', 'broad', 'forking', 'waxy'] },
    { id: 'stipe', label: 'Stipe', absent: 'Sessile — no stipe', measured: true,
      vocab: ['stipe', 'ring', 'annulus', 'volva', 'cortina', 'basal bulb', 'scabers', 'reticulation', 'equal', 'tapering', 'clavate', 'bulbous', 'hollow', 'stuffed', 'solid', 'fibrous', 'fragile', 'slender', 'eccentric', 'lateral', 'sessile'] },
    { id: 'sporePrint', label: 'Spore colour', absent: 'No print obtainable',
      vocab: ['white', 'cream', 'buff', 'pink', 'ochre', 'rust', 'cinnamon', 'brown', 'dark-brown', 'purple', 'black', 'yellow'] },
    { id: 'scent', label: 'Scent / taste', absent: 'Nothing distinctive', colourAs: 'descriptor',
      vocab: ['mild', 'bitter', 'acrid', 'peppery', 'farinaceous', 'anise', 'almond', 'radish', 'phenolic', 'sweet', 'fruity', 'apricot', 'fishy', 'garlic', 'rancid', 'earthy', 'nutty'] },
    { id: 'staining', label: 'Staining', absent: 'Does not stain',
      vocab: ['bruises blue', 'bruises brown', 'bruises red', 'bruises black', 'bruises yellow',
        'bruises green', 'bruises purple', 'bruises orange', 'bruises pink',
        'unchanging', 'slowly', 'immediately', 'latex'] },
    { id: 'substrate', label: 'Substrate', absent: 'No consistent substrate',
      vocab: ['soil', 'duff', 'leaf litter', 'moss', 'wood', 'dead wood', 'dead hardwood', 'rotten wood', 'stump', 'log', 'fallen branches', 'living tree', 'buried wood', 'woodchips', 'dung', 'burn site', 'grass', 'fungus', 'keratin'] },
    { id: 'trees', label: 'Associated trees', absent: 'Not tree-associated',
      vocab: ['douglas fir', 'western hemlock', 'sitka spruce', 'western red cedar', 'grand fir', 'shore pine', 'oak', 'garry oak', 'red alder', 'big-leaf maple', 'vine maple', 'birch', 'cottonwood', 'madrone', 'conifer', 'hardwood', 'mixed woodland'] },
    /*
     * How the fruit bodies stand together, which the other nine had no room
     * for. The guide says it constantly — "in large troops", "solitary",
     * "in dense clusters" — and it was landing under Fruit body or, worse,
     * under Gills, where "gills, clustered" reads as a fact about the gills.
     *
     * Always present: a mushroom grows somehow, so there is no N/A to tick.
     */
    { id: 'habit', label: 'Growth habit', absent: 'No consistent habit', alwaysPresent: true,
      vocab: ['solitary', 'scattered', 'gregarious', 'clustered', 'caespitose', 'troops', 'tufted', 'fairy ring',
        'hypogeous', 'partially emergent', 'epigeous'] },
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

  /**
   * A stored tag, in the shape the views want. Usually one; a measure can be
   * two, which is why this returns a list.
   *
   * Measures are read forward here. "up to 20 cm" and "3–10 cm" were written
   * as single tags before a measure was a number, and they become "20 cm" and
   * the pair "3 cm", "10 cm" on the way in — the same tags typing them today
   * would produce, so the stored spelling never matters again. A parsed
   * measure is a measure whatever category was stored beside it: the category
   * is a fact about the shape of the text, not a choice.
   */
  const readTags = (raw, spec) => {
    const text = String(typeof raw === 'string' ? raw : raw?.text || '').trim();
    if (!text) return [];
    // A size past the limit, stored before there was one, stays a note rather
    // than disappearing: a tag that vanishes on read is a tag nobody can fix.
    const measure = parseMeasure(text);
    if (measure?.values.length) return measure.values.map((cm) => ({ text: measureText(cm), category: 'measure' }));
    // A stored category is honoured even when the vocabulary disagrees: it was
    // set by hand, and the vocabulary is only ever a guess.
    const category = (typeof raw === 'object' && raw?.category) || classifyTag(text, spec);
    return [{ text, category }];
  };
  const readTag = (raw, spec) => readTags(raw, spec)[0] || { text: '', category: 'note' };

  /**
   * What typing something into a tag field produces.
   *
   * One tag, usually. A range typed as one — "3–10 cm" — is its two ends, and
   * a size the app will not hold comes back as no tags and a reason, so the
   * field can say so instead of filing it as a note.
   */
  function tagsFrom(text, spec) {
    const measure = parseMeasure(text);
    if (measure?.error) return { tags: [], error: measure.error };
    return { tags: readTags(text, spec), error: null };
  }

  /** Tags with a measure already recorded, so a pasted list cannot double one. */
  const dedupeTags = (tags) => {
    const seen = new Set();
    return tags.filter((t) => {
      const key = normalizeTag(t.text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
      const tags = dedupeTags((Array.isArray(raw.tags) ? raw.tags : splitToTags(raw.text)).flatMap((t) => readTags(t, spec)));
      return { na: false, tags, state: tags.length ? 'recorded' : 'unrecorded' };
    }
    // Free text, from before the characters were tagged, or hand-edited in.
    if (typeof raw === 'string' || Array.isArray(raw)) {
      const tags = dedupeTags((Array.isArray(raw) ? raw : splitToTags(raw)).flatMap((t) => readTags(t, spec)));
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
    return displayTags(c.tags).map((t) => t.text).join(', ');
  }

  /** Everything said about a fungus, for a summary. Silent on what is unsaid. */
  function fungiTraits(sp) {
    if (!sp || sp.kind !== 'fungi') return [];
    const out = [];
    for (const spec of FUNGI_CHARACTERS) {
      const c = character(sp, spec.id);
      if (c.state === 'unrecorded') continue;
      // A species' measures read as one range chip; see displayTags.
      const tags = displayTags(c.tags);
      out.push({
        // The character this came from, so a caller can line the row up
        // against a tag recorded under the same one.
        id: spec.id,
        label: spec.label,
        value: c.state === 'absent' ? spec.absent : tags.map((t) => t.text).join(', '),
        tags,
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
   *
   * `relatives` is deliberately absent. Those are other species mentioned in
   * this one's entry, not other names for this one, and folding them in would
   * make a search for a relative return this record and the iNaturalist lookup
   * return a different fungus's observations.
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
   * Does this species record the given term under any character?
   *
   * Compared as canonical forms, so a search for "false gills" finds the
   * species tagged "ridges" — the two are one term for matching everywhere
   * else, and a filter that disagreed with the matcher would be a trap.
   */
  function speciesHasTag(sp, term) {
    // A measure is matched by range, not by spelling: "8 cm" finds every
    // species whose recorded size takes in eight centimetres.
    const cm = measureOf(term);
    if (cm !== null) {
      return FUNGI_CHARACTERS.some((spec) => withinRange(cm, measureRange(character(sp, spec.id).tags)));
    }
    const want = new Set(queryGroups(term));
    if (!want.size) return false;
    return FUNGI_CHARACTERS.some((spec) =>
      character(sp, spec.id).tags.some((t) => want.has(termGroup(t.text))));
  }

  /**
   * What the species search box matches: names, and nothing else.
   *
   * It used to match habitat, division, lookalikes, edibility, nutrition and
   * every character tag as well, and the breadth was the problem rather than
   * the feature. Two thirds of the library names a lookalike, so searching
   * `chanterelle` returned every species that warns about one with the
   * chanterelles themselves somewhere in the middle of the pile; `oak` came
   * back with everything recorded as growing near one. A box sitting above a
   * list of names is a box people type names into.
   *
   * All three kinds of name are matched — see speciesNames — because records
   * exist under all three, and a species findable only by the name this
   * library happens to prefer is a species that cannot be found.
   *
   * Characters did not lose their way in; they got a better one. The tag
   * filter matches them through speciesHasTag, on canonical forms, so `false
   * gills` finds a species recorded as `ridges` — which this never did.
   */
  function speciesText(sp) {
    return [sp.commonName, ...speciesNames(sp)].filter(Boolean).join(' ').toLowerCase();
  }

  /* ==========================================================================
   * Excerpts — what the guides say, in their own words.
   *
   * Every other field on a species is *this library's* answer: one habitat,
   * one edibility, one line of lookalikes, arrived at by reading around and
   * deciding. An excerpt is the opposite. It is one guide's account, kept
   * whole and unedited, with the guide named beside it — so a later pass over
   * a second book adds a second excerpt rather than overwriting the first, and
   * two guides that disagree are visibly two guides disagreeing rather than a
   * field that quietly changed.
   *
   * `source` is the natural key: one excerpt per guide. A scraping pass that
   * revisits a book should replace the excerpt carrying that source rather
   * than appending a near-duplicate. Nothing enforces it — a duplicate source
   * is untidy, not corrupt — but that is the intended shape.
   *
   * `notes` is still yours. The distinction is the point: notes are what you
   * concluded, an excerpt is what you read.
   * ========================================================================== */

  /** One excerpt, with both halves guaranteed to be strings. */
  const readExcerpt = (raw) => ({
    source: String(raw?.source ?? '').trim(),
    // Scraped text arrives with whatever line endings the source had, and a
    // stray \r would survive into the middle of a rendered paragraph.
    text: String(raw?.text ?? '').replace(/\r\n?/g, '\n').trim(),
  });

  /**
   * Every excerpt on a species. Absent means none — a species predating this
   * field is not a species with an empty guide entry, and both read the same.
   */
  function excerpts(sp) {
    const list = Array.isArray(sp?.excerpts) ? sp.excerpts : [];
    return list.map(readExcerpt).filter((e) => e.source || e.text);
  }

  /*
   * The markup an excerpt is written in.
   *
   * A field guide's prose is italics, bold and the occasional bulleted list,
   * and nothing else — so that is the whole grammar. Deliberately not HTML:
   * this text is going to be written by scrapers reading other people's pages,
   * and a stored fragment of someone else's markup is a stored fragment of
   * someone else's markup. Parsing to a structure the renderer walks node by
   * node means nothing in an excerpt can ever become an element.
   *
   * It is also total. There is no such thing as invalid excerpt text: an
   * unpaired asterisk is an asterisk. A parser that could reject its input
   * would be a parser that could lose a book's worth of scraped text.
   */

  // A leading -, * or • starts a bullet. The space is required, so a paragraph
  // opening on *an italic phrase* is not mistaken for a list.
  const BULLET = /^\s*[-*•]\s+(.*)$/;

  /*
   * Longest marker first, or ***both*** parses as bold of "*both".
   *
   * Two guards, and each is a real mushroom description rather than a
   * hypothetical. `(?=\S)` — an opener is followed by a non-space — is what
   * stops "spores 5 * 3 µm, basidia 30 * 8 µm" italicising the middle of the
   * sentence. The `(?!\*)` pair — a single marker is a single marker — is what
   * lets *Amanita **muscaria** var. flavivolvata* close on its own final
   * asterisk instead of on the first one of the bold pair inside it.
   *
   * Written without lookbehind on purpose: this runs on a phone, and a Safari
   * old enough to lack it would fail to parse this file at all rather than
   * merely render an excerpt oddly.
   */
  const EMPHASIS = /\*\*\*(?=\S)([\s\S]*?[^*\s])\*\*\*|\*\*(?=\S)([\s\S]*?[^*\s])\*\*|\*(?!\*)(?=\S)([\s\S]*?[^*\s])\*(?!\*)/;

  /** One line of text as marked-up runs: `{ text, bold, italic }`. */
  function spansOf(text, marks = { bold: false, italic: false }) {
    const out = [];
    let rest = String(text ?? '');
    while (rest) {
      const m = rest.match(EMPHASIS);
      if (!m) { out.push({ ...marks, text: rest }); break; }
      if (m.index) out.push({ ...marks, text: rest.slice(0, m.index) });
      const inner = m[1] ?? m[2] ?? m[3];
      const added = m[1] != null ? { bold: true, italic: true }
        : m[2] != null ? { bold: true }
        : { italic: true };
      // Recursive, so *italic with **bold** inside* keeps both marks.
      out.push(...spansOf(inner, { ...marks, ...added }));
      rest = rest.slice(m.index + m[0].length);
    }
    return out.filter((s) => s.text);
  }

  /**
   * Excerpt text as blocks a renderer can walk:
   *
   *   { kind: 'paragraph', spans }
   *   { kind: 'list', items: [spans] }
   *
   * A blank line ends a block. Inside a paragraph, single newlines are joined
   * with a space — scraped text is hard-wrapped at whatever width the page
   * was, and honouring those breaks would rag every paragraph in the library.
   * A bullet is therefore one line; a wrapped one continues as prose.
   */
  function richText(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = [];
    let items = null;

    const flushPara = () => {
      if (!para.length) return;
      blocks.push({ kind: 'paragraph', spans: spansOf(para.join(' ')) });
      para = [];
    };
    const flushList = () => {
      if (!items) return;
      blocks.push({ kind: 'list', items });
      items = null;
    };

    for (const line of lines) {
      const bullet = line.match(BULLET);
      if (bullet) {
        flushPara();
        (items ||= []).push(spansOf(bullet[1].trim()));
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line.trim());
    }
    flushPara();
    flushList();

    return blocks.filter((b) => (b.kind === 'list' ? b.items.length : b.spans.length));
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
    // Stipe placement as a whole-body form, the way the guide uses them:
    // pleurotoid is the oyster build, collybioid the slim central stipe.
    pleurotoid: 'pleurotoid', oyster: 'pleurotoid',
    collybioid: 'collybioid',
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
   * Every group that satisfies a search for this term — the term's own, plus
   * the narrower ones it covers.
   *
   * One direction only, and that is the whole point. `bruises blue` is a
   * narrower claim than `blue`: it says the colour arrived when the flesh was
   * cut. So a search for `blue` should turn up the species that bruise it,
   * while a search for `bruises blue` should not turn up every blue cap.
   * Folding the two into one group — the obvious fix — would have done both,
   * and would also have made a search for `bruises white` return the milk-caps
   * whose latex is merely white.
   *
   * The staining character was where this bit. Seventeen species record a bare
   * colour there and nine `bruises` terms exist beside them, and until now the
   * two could not find each other: `blue` matched none of the eighteen species
   * recorded as bruising blue.
   *
   * Derived from DESCRIPTORS rather than kept as a second table, so a
   * `bruises white` added there is found by a search for `white` with no
   * further edit here.
   */
  function queryGroups(text) {
    const key = normalizeTag(text);
    if (!key) return [];
    const groups = [termGroup(key)];
    const bruised = `bruises ${key}`;
    if (DESCRIPTORS.has(bruised)) groups.push(termGroup(bruised));
    return groups;
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
      //
      // Deliberately NOT the widening speciesHasTag uses. There, `blue` is a
      // net cast wide and `bruises blue` is a fair catch. Here the two sides
      // are asserting agreement, and a bare colour does not agree with a
      // bruise: a specimen whose cap you tagged `brown` is not confirmed by a
      // species whose cap is recorded as `bruises brown`, which says the
      // colour was not there until the cap was handled.
      const have = new Set(known.tags.map((t) => termGroup(t.text)));
      // A size is compared as a number against the species' range, never as a
      // word: a specimen at 8 cm agrees with a species recorded 3–10 cm even
      // though no tag on the species says "8 cm". Outside the range it fails
      // to score, like any other tag the species does not have — a guide's
      // range is typical, not a wall, and a cap two centimetres over it is
      // not a different organism.
      const range = measureRange(known.tags);
      for (const tag of seen) {
        const cm = measureOf(tag.text);
        if (cm !== null) {
          if (withinRange(cm, range)) matched.push({ character: spec, tag, range });
          else unmatched += 1;
        } else if (have.has(termGroup(tag.text))) matched.push({ character: spec, tag });
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

  /** An altitude written on the record itself, which outranks any derivation. */
  function recordedElevation(obs) {
    return Number.isFinite(obs.elevation)
      ? { metres: Math.round(obs.elevation), source: 'recorded' }
      : null;
  }

  /**
   * How high a find was, from the photographs that recorded it.
   *
   * The median rather than the mean: a burst of three frames where one caught a
   * bad fix should not drag the answer, and with an even count the midpoint of
   * the two middles is still inside the spread of what the phone believed.
   *
   * This is the camera's altitude, not the ground's. They agree closely enough
   * on flat ground and diverge on a slope, so the source rides along with the
   * number and the two are never presented as the same fact.
   */
  function photoElevation(obs) {
    const seen = (obs.photos || [])
      .map((p) => p && p.altitude)
      .filter((a) => Number.isFinite(a))
      .sort((a, b) => a - b);
    if (!seen.length) return null;
    const mid = seen.length >> 1;
    const metres = seen.length % 2 ? seen[mid] : (seen[mid - 1] + seen[mid]) / 2;
    return { metres: Math.round(metres), source: 'photo', samples: seen.length };
  }

  /**
   * Metres, written the way the rest of the log writes measurements. The space
   * is non-breaking: on a phone the find card is half a screen wide, and a
   * plain space leaves the unit stranded on a line of its own under the number.
   */
  const formatElevation = (metres) => (Number.isFinite(metres) ? `${Math.round(metres)}\u00a0m` : '');

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
    typeLabel, typeGlyph, edibility, isChoice, isDubious, isDangerous, speciesHasTag,
    findEdibility, edibilityCounts, ageOpacity,
    character, characterValue, characterVocab, nutrition, speciesText,
    matchSpecies, rankCandidates, observedTagCount,
    classifyTag, tagSwatch, tagCategory, normalizeTag, readTag, readTags, tagsFrom, characterSpec,
    MEASURE_MAX_CM, parseMeasure, measureText, measureOf, measureRange, withinRange, displayTags,
    bodyGroup, bodyConflict, applyGlossary, synonymsOf, guessCategory, termGroup, queryGroups,
    byId, view, viewAll, displayName,
    summary, latestOf, lifeList,
    filter, sortByDate,
    fungiTraits, speciesNames, formatCoord, mapLink, bounds,
    excerpts, richText,
    photoElevation, recordedElevation, formatElevation,
  };
})();

if (typeof module !== 'undefined') module.exports = Model;
