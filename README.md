# Field Notes

A local, single-user journal. The first view is a **nature log**: what you
found, where, and what it turned out to be.

Same shape as `finances` — no dependencies, no build step, all the logic in the
browser — so the two read as one set of tools and can merge later.

```bash
node server.js
```

Then open http://127.0.0.1:4175. It also listens on every interface, so it is
reachable from the phone the photos were taken on — the startup banner prints
the addresses.

**There is no authentication.** Anyone who can reach the port can read and
rewrite the whole log, and download every photograph in it. That is fine on a
trusted home network or a private mesh; it is not fine on shared wifi, and the
app should never be exposed directly to the internet. Set `HOST=127.0.0.1` in
`.env` to restrict it to this machine.

## The flow

```
   log it                    identify it                    it has a name
┌──────────────┐          ┌────────────────┐          ┌────────────────────┐
│ photos       │          │ tag what you   │          │ species linked     │
│ type         │  submit  │ can see        │  choose  │ confidence set     │
│ when / where │ ───────► │ ↓              │ ───────► │ name derived       │
│              │          │ library ranks  │          │ ↓                  │
│              │          │ itself         │          │ "Chanterelle?"     │
└──────────────┘          └────────────────┘          └────────────────────┘
   Unidentified            tap an unidentified          tap it again to
                           find to open this            see the record
```

**Logging and naming are separate acts.** The entry form asks only for what you
cannot recover later — the photograph, and where and when you were standing.
It has no species picker, because standing in the woods holding a mushroom is
usually the moment you know least about it. Every find starts *Unidentified*,
which is a normal state and not a failure.

Tapping an unidentified find opens the **identification sheet**. Tag what the
specimen shows — *gills: adnate, crowded*; *cap: brown, hygrophanous* — and the
library ranks itself against those tags as you type. Pick a species, set a
confidence, and it has a name. Or press **Save tags only** and come back when
you have a spore print.

Tapping an identified find opens its record instead, which carries a
**Re-identify** button back into the sheet.

### How the ranking works

A species is ruled out only by **contradiction**. There are two kinds:

- **A recorded absence.** You tagged a stipe, and its record says *sessile — no
  stipe*.
- **A disagreeing fruit body.** You tagged `bracket`, and its record says
  `coral`. This is the only character where a mismatch rules anything out, because
  it is the only categorical one — a bracket is not a coral, and no amount of
  variation closes that gap. Cap colour, gill spacing and the rest genuinely vary,
  so a mismatch there only fails to score.

The body test runs on **synonym groups, never on words**: `bracket`,
`polypore` and `polyporoid` are one group, so writing one where the library
holds another cannot rule anything out. A form the group table does not know —
`fan`, which covers both bracket-like and crust-like fungi — never contradicts
at all. And colour on the body character is ignored for this: an orange
specimen of a species recorded as yellow is a variation, not a different
organism.

Either way it says so in as many words and sinks to the bottom rather than
disappearing, because a contradiction is usually right but can also mean the
specimen was misread.

**A toxic or deadly species is never dimmed, ruled out or not.** Tagging
`morel` rules out the false morels — which is exactly the moment someone who
has confused the two needs to see them and read why. Those rows keep full
opacity and a warning edge.

A tag the species simply does not mention is **not** evidence against it. The
library is half-written by definition, and scoring absence as a "no" would
eliminate every correct answer for want of a note. Species are ranked by how
many tags they match, then by how few they miss.

When nothing fits, **None of these — write it up** opens a new species with
your tags already filled in, and links it to the find on save.

## The one idea the log is built on

**An observation's name is not stored.** It is derived, every time it is drawn,
from the species it points at:

| Species linked? | Confidence | Name shown              |
| --------------- | ---------- | ----------------------- |
| no              | —          | *Unidentified*          |
| yes             | high       | Golden Chanterelle      |
| yes             | low        | Golden Chanterelle**?** |

So correcting a species — or finally identifying something six months later —
renames every observation of it at once. A stored name would have to be found
and rewritten everywhere, and the ones that were missed would quietly disagree
with the species record.

The same reasoning is why deleting a species does **not** clear the finds that
point at it. They keep the dangling id and read as unidentified until you
re-link them, rather than silently destroying an identification.

## The two records

**Observation** — a find. Photographs, a time and a place, the characters you
tagged on the specimen, an optional link to a species, and how sure you were.
Type (Fungi / Flora / Fauna) is stored even when a species is linked, because
it is what the find falls back to if that species is ever deleted.

An observation's characters and a species' characters use the same shape and
the same tags, but they are never merged: one is what you saw, the other is
what the organism is supposed to be. The record sheet shows them as **What you
saw** and **The species**, one above the other, which is the comparison.

**Species** — the organism, not the encounter. Common and scientific name,
habitat, example photographs, edibility, lookalikes, and the guides' own words
under [Excerpts](#excerpts).

Three kinds of name, kept apart because the difference matters when looking a
species up:

| Field | Means |
| --- | --- |
| **Scientific name** | what this library calls it |
| **Also known as** | another *current* name for the same organism |
| **Former scientific names** | names it has been retired from |

The middle one exists because a field guide and iNaturalist can simply
disagree. *Mushrooms of the Pacific Northwest* files the western matsutake
under *Tricholoma magnivelare*; iNaturalist splits it out as *T. murrillianum*.
Searching only the guide's name finds a single record in the whole region;
searching both finds several hundred. All three fields are searched, and
iNaturalist unions the results.

## Fungal characters

Shown only for fungi: subkingdom/division, former scientific names, how it
feeds (saprophytic / mycorrhizal / both), and nine characters, in roughly the
order a key walks them:

> **Fruit body** · Cap · Gills / pores · Stipe · Spore colour · Scent / taste ·
> Staining · Substrate · Associated trees

**Fruit body** holds the growth form (`cup`, `coral`, `bracket`, `morel`,
`agaricoid`) and the overall colour. It exists because the parts could not hold
them: once a cup fungus correctly marks `cap` and `hymenium` absent, its
defining feature — a brilliant orange cup — has nowhere left to live. It is
also the fastest way to narrow an identification, since tagging `cup`
eliminates every gilled mushroom at a stroke.

It is the one character that can never be absent. If you are holding a
specimen, it has a fruit body, so the N/A tick is suppressed rather than
offered and left meaninglessly unticked.

Each holds **tags**, not prose. Prose could not be queried: a record reading
"neither gills nor pores" contains the word *pores*, so searching for pores
returned the one mushroom that most definitely has none. A tag is a thing the
species either has or does not — which is what a key asks, and what the tag
filter answers. Clicking a tag anywhere filters the library to it, matching on
canonical forms, so `false gills` finds a species recorded as `ridges`.

Type and press Enter; commas split a pasted list; Backspace on an empty box
takes the last tag back.

### Tags colour themselves

Every tag carries a category, and the category is what gives it its colour, so
a colour word and an attachment term never look like the same kind of claim:

| Category       | Colour            | Examples                              |
| -------------- | ----------------- | ------------------------------------- |
| **form**       | amber             | gills, false gills, pores, ring, volva |
| **colour**     | a swatch of itself | egg-yellow, olive, pale yellow        |
| **descriptor** | blue              | decurrent, adnate, crowded, viscid, bitter |
| **habitat**    | green             | soil, duff, dead hardwood, Douglas fir |
| **measure**    | mono grey         | 3–10 cm, 3–5 per mm                   |
| **note**       | dashed grey       | anything the vocabulary does not know |

The category is **guessed** from a built-in mycological vocabulary and can be
corrected in the **Glossary**. A guess with no way to correct it would be worse
than no guess.

One rule makes the guess context-aware, because a word can mean different
things under different characters: under **Scent / taste** a colour name is a
smell, so *apricot* is a descriptor there and a colour under **Cap**.

**Anything the vocabulary does not know stays a note — dashed and grey.** It
would be easy to guess from the character it was typed into; an unlisted tree
under *Associated trees* is almost certainly a tree. But a guess that always
looks right is a guess nobody ever checks, and the grey is what makes the gaps
in the vocabulary visible. That is the only way the vocabulary gets better.

The word lists are plain arrays at the top of `public/model.js` — `FORMS`,
`DESCRIPTORS`, `HABITATS` and `COLOURS`. Add to them as the log grows.

A colour tag paints the colour it names. The text stays neutral: some of these
are near-black, and a "black" tag written in black would be unreadable.

### N/A is still a claim

Each character has **three states, which must never collapse into each other**:

| State          | Stored                       | Means                                        |
| -------------- | ---------------------------- | -------------------------------------------- |
| **unrecorded** | key absent                   | nobody has written it down yet               |
| **recorded**   | `{ na: false, tags: [ … ] }` | one or more tags                             |
| **absent**     | `{ na: true }`               | this species genuinely has no such structure |

A chanterelle has no true gills; a puffball has no stipe; a saprophyte has no
associated tree. "No gills" sends you down one half of a key — "gills not
noted" sends you nowhere, and no-tags cannot tell the two apart on its own.

Each character carries its own wording for absence — *Sessile — no stipe*,
*Does not stain*, *Neither gills nor pores*, *Not tree-associated* — and it is
styled as a stated value rather than as a blank. **That wording is deliberately
excluded from search**, which is what stops it matching the words it negates.

Older records are read forward on load: free text splits on its commas into
tags, and the `gills` / `stipe` tri-state that preceded it becomes tags or an
explicit absence. Superseded keys are dropped the next time the species is saved.

## The search box

The box above the species library matches **names, and nothing else**: the
common name, the scientific name, the synonyms, and the former names. It is
also the only thing the box does — a name is what people type into a field
sitting above a list of names.

It used to match habitat, division, lookalikes, edibility, nutrition and every
character tag as well, and that breadth was the problem rather than the
feature. Two thirds of the library names a lookalike, so `chanterelle` returned
every species that warns about one, with the chanterelles themselves somewhere
in the middle of the pile. `oak` came back with everything recorded as growing
near one.

Characters did not lose their way in; they got a better one. Clicking a tag
filters the library to it, and that filter matches on canonical forms — so
`false gills` finds a species recorded as `ridges`, which the text search never
did. The two are complementary and can be combined: filter to `hydnoid`, then
type a name.

## The Glossary

Every term the log knows, what it means, what it is classified as, and which
terms are treated as the same thing.

Definitions come from the field guide's own glossary where it has one, and are
written here where it does not; each says which. A term with no definition yet
is not an error — the Undefined filter is the writing queue, the same way
dashed grey tags are the vocabulary queue.

**Terms usually arrive from the other direction**: you tag a species and the
word turns up here wanting a definition. The line above the table is for the
case that goes the other way — a word read in a guide before you have met the
thing it describes. A term added by hand is kept even when nothing is recorded
about it and nothing is tagged with it; otherwise it would vanish the moment
you gave it the category the vocabulary already guessed.

**The cross at the end of a row forgets what is recorded about a term**, not
the term itself. A word something is tagged with cannot be removed from this
list — the list is a reading of the tags — so deleting it clears its definition
and category and leaves it sitting in the writing queue. Only a term nothing
points at disappears outright. The prompt says which of the two you are about
to do.

**A category is set here and nowhere else.** It used to be a click on the tag
wherever it happened to appear, which made a global fact look like a local
edit: reclassifying `angular` on one mushroom said nothing about the next one.
A term's category is a property of the term, so it is set once and every use
follows.

Choosing the category the vocabulary would have guessed **clears** the override
rather than pinning it. Storing a redundant override would freeze the term
against a later change to the word lists, which is the opposite of useful.

**Same as** is where two words for one idea are made one term. Point `ridges`
at `false gills` and a specimen tagged either matches a species recorded as
either — they are one character of one mushroom described two ways, and a key
that treats them as different fails to match a chanterelle against itself.

Three sources feed it, and the column shows all of them: pairings you set here,
the growth-form groups (`bracket` = `polypore` = `polyporoid`, so writing one
where the library holds another cannot rule a species out), and the
`gray`/`grey` fold. Pairings are transitive and shown in both directions, so a
synonym is never invisible from one side.

What it does **not** do is merge things that merely sound similar: `gills` and
`false gills` stay distinct, because they are different structures and the
distinction is the whole point of the second name.

Measurements are left out. "3–10 cm" is a value, not a word to define, and they
would bury the terms that are.

## Excerpts

Every other field on a species is *this library's* answer — one habitat, one
edibility, one line of lookalikes, arrived at by reading around and deciding.
An excerpt is the opposite: one guide's account, kept whole and unedited, with
the guide named beside it.

```json
"excerpts": [
  {
    "source": "Mushrooms of the Pacific Northwest (2009), Trudell & Ammirati",
    "text": "Cap 1-3 cm, **hemispheric** becoming plane, *viscid* when moist.\n\nTold apart from *Panaeolus foenisecii* by:\n- a **rust-brown** spore print"
  }
]
```

Reading a second book adds a second excerpt rather than overwriting the first,
so two guides that disagree are visibly two guides disagreeing instead of a
field that quietly took the newer answer. `source` is the natural key: one
excerpt per guide, and a scraping pass that revisits a book should replace the
excerpt carrying that source rather than appending a near-duplicate. Nothing
enforces it — a duplicate source is untidy, not corrupt.

`notes` is still yours. The distinction is the point: notes are what you
concluded, an excerpt is what you read.

### The markup

A field guide's prose is italics, bold and the occasional bulleted list, and
nothing else, so that is the whole grammar:

| Written | Reads as |
| --- | --- |
| `*viscid*` | *viscid* |
| `**stout**` | **stout** |
| `***no***` | ***no*** |
| a line starting `- `, `* ` or `• ` | a bullet |
| a blank line | the end of a paragraph or list |

Deliberately not HTML. This text is going to be written by scrapers reading
other people's pages, and a stored fragment of someone else's markup is a
stored fragment of someone else's markup. `Model.richText` parses it to blocks
and runs, and the sheet builds those node by node — nothing in an excerpt can
become an element.

It is also **total**: there is no such thing as invalid excerpt text. An
unpaired asterisk is an asterisk, `5 * 3 µm` is a measurement rather than the
start of an italic phrase, and a paragraph opening on *a scientific name* is
not a bullet. A parser that could reject its input would be a parser that could
lose a page it had already fetched. `test/excerpts.test.js` holds those cases.

Inside a paragraph, single newlines are joined with a space. Scraped text is
hard-wrapped at whatever width the page was, and honouring those breaks would
rag every paragraph in the library — which also means a bullet is one line, and
a wrapped one continues as prose.

Excerpts are **not** searched by the species search box — see
[The search box](#the-search-box), which matches names only. A book's paragraph
explaining that the chanterelle has no pores is exactly the kind of text that
made a search for `pores` return it. Giving them a scope of their own is a
small change if the library ever holds enough excerpts to want one.

## Photographs carry their own metadata

Drop a photo into the entry form and the date and location fill themselves in.
`public/exif.js` reads the EXIF directly out of the file:

- **JPEG** — the APP1 marker segment, walked properly.
- **HEIC/HEIF** — every modern iPhone. The same EXIF block, buried in an
  ISOBMFF item; the parser scans for the signature and confirms it by the byte
  order mark that must follow.
- **TIFF/DNG** — the file *is* the TIFF.

The time is kept as a **local, zone-less wall time**, because that is what the
tag means: the clock reading where the shutter fired. A GPS block with no fix
writes 0,0 — the Atlantic — which is read as "no location" rather than as a
coordinate.

EXIF only ever fills a field that is **empty**. A typed correction survives
dropping a second photo in, and the photo's own reading is the more likely of
the two to be wrong: a camera clock left on the wrong zone, a fix taken back at
the trailhead.

Every upload also gets a downscaled JPEG preview, generated in the browser.
That keeps the gallery from pulling twenty 4 MB originals — and because Safari
can decode HEIC and nothing else can, a photo added from an iPhone is what
makes that find visible in every other browser later.

## Edibility

Marked on the species, not on the find, and it is a **scale rather than a
flag**:

> Not recorded · Choice edible · Edible · Inedible · **Dubious** · Toxic · Deadly

A field that could only say "good to eat" or "nothing recorded" would be the
wrong shape for this subject: the records you most need to be unambiguous are
the ones that will hurt you. There is a free-text **Lookalikes** field beside
it, which is the thing that actually matters when deciding.

**Dubious** sits above Inedible and below Toxic: eaten by some people, and it
disagrees with others — *Ramaria* and its "laxative in some" is the type case.
Inedible is merely unpalatable; this carries real risk, which is why it ranks
higher. It is recorded rather than rounded off to either neighbour, because
"some people do" is the only thing it says and rounding loses it. Its badge is
dashed amber — a warning that is not a prohibition.

Choice edibles get a ring on the map, a dot on the gallery card, a filter of
their own, and a tally on both consoles.

**This is your own notebook, not an identification authority.** The app says so
under the control, and it is worth repeating here: nothing in a personal log
should be the last word before eating a wild mushroom.

## The map

`public/map.js` is a slippy map in about three hundred lines and no dependency
— Web Mercator, a tile grid, pan, zoom, and pins. Leaflet would be the obvious
answer and it is a good library; it is also a network dependency in an app
whose point is to work in a forest.

A pin says two things at once. Its shape is whose record it is — a circle for
your own find, a triangle for somebody else's — and its colour and fill are how
edible it is, in the same language as the edibility badges: solid where the
badge has a background (choice, deadly), hollow where it does not, dashed where
the badge is dashed (not recorded, dubious). That applies to fungi, the group
where edibility is worth reading off a map at a glance; flora and fauna keep
their kingdom colour. iNaturalist's triangles are smaller and drawn underneath,
so somebody else's identification can never be mistaken for one of yours.
Filter by type, by identification, by any set of edibility tiers, or by
species.

Tiles are **proxied through this server and cached to disk**, which is the
reason for the proxy: the browser never talks to a tile server directly, so no
third party gets a running log of where you have been looking — and ground you
have already looked at still draws with no signal. When tiles cannot be
fetched at all, the map falls back to a graticule and says so; the pins are
still in the right places.

Delete `tiles/` to refresh the basemap.

## Elevation

How high a find was, on its card and in its record. Optional, on by default,
and switched off with `elevation.enabled: false` in `config.json`.

Two sources, and they are not the same measurement:

- **The photographs**, when they carried a `GPSAltitude` — which phones usually
  do. This is where *you* were standing, and it is the better number. Several
  photographs of one find give their median, so a single bad fix in a burst
  cannot drag the answer.
- **The ground**, from the USGS 3DEP terrain model, when no photograph recorded
  an altitude. This is the elevation of the ground at the coordinate, not a
  measurement taken on the day, and it is written `~1419 m` on a card to say so.

3DEP is **United States only** and has no key. Answers are cached to disk under
`elevation/`, one file per coordinate rounded to four decimal places (about
11m), because terrain does not move. The first lookup for a coordinate takes
ten to twenty seconds — the service queries a raster per point — and every
lookup after it is a disk read. Nothing waits on it: the card is already drawn
and the number arrives afterwards.

Where the model has a hole it answers `0.000000000` rather than an error. An
exact zero is therefore treated as no data, which costs a genuine tideline find
its elevation and is much the better trade — the alternative prints `~0 m`
under a photograph taken well up a mountain.

Delete `elevation/` to re-ask.

## Recent rainfall

Where it has already rained, drawn under the pins. The umbrella button on the
map turns it on; it is off until asked for, because most sessions are about a
find you already have. Optional, and switched off entirely with
`rain.enabled: false` in `config.json`.

This is the one layer that is not about the log. The log knows where you have
already been; this answers where to go next, which for fungi is mostly a
question about water — they fruit days behind the rain, so ground that was
soaked last week is the signal.

Nearly every free weather API is **forward** looking, because a forecast is
what most callers want. This uses [Open-Meteo](https://open-meteo.com)'s
`past_days`, which fills observed days in on the same endpoint that serves
forecasts. No key, no signup, and it will answer in inches. Their data is
CC-BY, which the credit line under the map carries.

**The window is whole days ending yesterday** — seven of them by default, set
with `rain.days`. Today is deliberately excluded: it is half-measured and
revises upward all afternoon, so including it would make the same ground answer
differently before and after dinner.

**Samples snap to a fixed global lattice** rather than to the viewport, at one
of five spacings from 0.05° to 0.8°. Panning otherwise produces a different
bounding box every few pixels and a cache keyed on the box would miss on every
one of them; snapped, the same ground answers with the same coordinates however
you got there, so a pan re-reads what is already on disk and asks upstream only
about the strip that just came into view. Each spacing is twice the one below
it, so the coarse lattices are subsets of the fine ones and zooming out re-uses
every other cell.

The finest spacing that covers the screen in under six hundred points wins.
**When even the coarsest one cannot cover it, the layer draws nothing and says
"zoom in to sample this area"** rather than shading the part it could reach —
a half-sampled map is indistinguishable from a map of genuinely dry ground, and
that is the one way this layer could actively mislead. `test/rain.test.js`
holds that invariant, because it is a failure with nothing to see.

The wash is composited onto the tiles with `screen`, so it tints rather than
covers: over a uniformly wet region a translucent overlay meets itself and
becomes a flat blue rectangle with the roads and ridgelines gone, and a map you
cannot navigate is no use for deciding where to walk. The bands run blue to
pale cyan, clear of the greens, ambers and reds the edibility tiers own — a
wash in those colours would read as a claim about what is growing there.

This is reanalysis, not a rain gauge in that clearing, and the blur says so:
the smear is about as wide as one cell, so the picture cannot be read to a
precision the model does not have.

Answers are cached under `rain/`, one file per lattice cell, and re-fetched
when the date rolls over. Delete `rain/` to re-ask.

## iNaturalist

Optional, on by default, and switched off with `inaturalist.enabled: false` in
`config.json`.

- **On the map** — research-grade observations from other people in the box you
  are looking at, as triangles. Narrowed to the kingdom you have filtered to,
  and to a single taxon when you pick a species that has been matched against
  iNaturalist. "Where does everyone else find chanterelles" is the question it
  answers.
A species record can carry an iNaturalist taxon id, which is what lets the map
ask for that exact taxon rather than guessing from a name. The editor no longer
sets one — the name lookup that did has been removed — but an id already on a
record is carried through every save untouched.

Their photographs are proxied too, through a host allowlist, so the page makes
no third-party requests at all. Responses are cached for five minutes because
panning re-asks constantly and their terms ask callers to be gentle. Set
`TRACKER_USER_AGENT` in `.env` to something with your contact address, which is
what they ask for.

**The clock button under the umbrella** narrows the map to the past month —
their records and your own alike. Research-grade observations go back years and the map draws them all,
faded with age, which answers "where does this species grow" well and "is
anyone finding it right now" badly — a single week's flush disappears into a
decade of pins. Thirty-one days is the window: shorter and a quiet week reads
as nothing at all, longer and last autumn crowds out this one. It narrows what
is drawn, not what is fetched, so it costs no extra request and toggles
instantly. A record with no date is not shown as recent.

It narrows the **map only**, deliberately. The button lives there, and a filter
that went on quietly shortening the gallery from a control you cannot see there
is a filter you would eventually lose a find to.

If iNaturalist is unreachable the map says so quietly and carries on. Your own
pins are unaffected.

## Links, and widgets on a phone

Every view already lived in the URL — `?view=`, `?mode=`, `?tag=`. Two more
parameters put a single record there:

```
?find=vpxp66nq                    that observation, in its sheet
?species=amanita-muscaria         that species, in its sheet
```

The app writes them itself. Open a find and the address bar says so; close it
and the parameter goes. So the link a widget opens and the link you could copy
out of a tab are the same string, and a back gesture closes the sheet rather
than leaving the log. A link to a record that has since been deleted says so
and leaves you on the view it named, rather than on the wrong thing.

`widgets/` holds three [Scriptable](https://scriptable.app) scripts for an
iPhone home screen:

| | shows | tapping opens |
| --- | --- | --- |
| `field-notes-species.js` | an example photograph from the library | that species |
| `field-notes-find.js` | a photograph from one of your finds | that find |
| `field-notes-map.js` | your finds as pins on the basemap | the map view |

Copy a file into Scriptable, add a widget of any size, choose the script, and
put the address of your log — `http://192.168.0.60:4175` — in the widget's
**Parameter** field. That is the only configuration; the fallback at the top of
each file is for running the script by hand in the app.

The server picks what to show, at `/api/widget/species`, `/api/widget/find` and
`/api/widget/map`. A widget wakes on the system's schedule, draws once, and
remembers nothing, so choosing on the phone would mean pulling four hundred
species down a metered connection to throw all but one of them away. The
answers are small and carry the `link` to open, which is the whole contract:
a photograph, a caption, and where tapping it goes.

The photograph sent is the stored preview — at most a thousand pixels, and a
plain JPEG, which is also the only copy of an iPhone HEIC anything but Safari
can decode. Photographs adopted from iNaturalist carry their attribution into
the widget, because a home screen is as public a place as the app is.

The map widget draws itself: Web Mercator, a fit to the pins, tiles from this
server's own cache, and circles in the same colours the stylesheet gives them —
filled for choice and deadly, hollow for the rest. It shows your own records
only. The crowd-sourced pins are fetched in response to what is on screen, and
a home screen has no screen to respond to.

## Layout

```
server.js            the only server. Static files, JSON state, photo uploads,
                     and the two upstream proxies.
public/
  index.html         every view, hidden and shown by tab
  styles.css         black grounds, one configurable accent
  exif.js            EXIF reader — JPEG, HEIC, TIFF
  model.js           the log's rules. No DOM
  map.js             the slippy map. No dependency
  app.js             views and wiring
config.json          theme, map source, iNaturalist and elevation switches
data/
  observations.json  the finds
  species.json       the library
widgets/             Scriptable scripts for an iPhone home screen
photos/              uploads, named by a minted id
tiles/               cached basemap
elevation/           cached ground elevations, one file per coordinate
```

## Storage

Both collections are plain JSON arrays. Where they live is `lib/store.js`'s
business: files under `STATE_DIR`, or an S3-compatible bucket when `S3_BUCKET`
names one. Same interface either way, so the rest of the server never asks
which it got.

On the filesystem a save goes through a temp file and a rename, so an
interrupted write leaves the previous file intact rather than a truncated one.

Every record carries a `version`. The browser echoes back the one it loaded,
and a mismatch is rejected with a 409 — another tab or another device wrote
first, and silently discarding their edit is the one outcome worth refusing.
The browser reloads and says so.

That check catches a stale *client*. It does not catch two servers: both read
v5, both write v6, and one edit vanishes with nobody at fault. So a read also
returns a token for the exact stored version and a write presents it back — a
conditional PUT against the ETag on S3, a hash check under a lock on the
filesystem. An instance that loses the race re-reads and re-applies its change
to what is there now, eight times before giving up. Which means a race shows up
in development rather than only in production.

The S3 requests are signed with SigV4 using `node:crypto` rather than the AWS
SDK — a page of well-specified arithmetic against fifty packages, in a project
whose README opens by saying it has none. `node test/sigv4.test.js` checks the
signing against reference signatures taken from botocore. It exists because a
wrong signature and a wrong policy both come back as 403, and telling them
apart afterwards is expensive.

Photographs go in the bucket too, under `<prefix>/photos/`, and the local
`photos/` directory becomes a cache. The bucket is the truth; the cache is what
keeps the app working in a forest. A cached copy can never be stale, because
the bytes behind a minted id never change — it is either the photograph or it
is absent.

`scripts/upload-to-s3.js` makes the one-way trip that hands the bucket the
existing log. `--dry-run` first. It skips photographs already there, so an
interrupted run resumes by being run again.

A store with no config in it seeds itself from `example/` — a made-up handful
of finds in a made-up wood, with the dates shifted so the newest landed a few
days ago. An example that opens reading "last find: two years ago" teaches a
new setup nothing about what the app is for.

Photographs are immutable: an id is minted per upload and never reused, which
is what lets them be served with a long cache. Files nothing points at any more
are swept **by reachability from the records**, not by reference counting — a
count has to be maintained correctly at every edit, and one missed decrement
leaks a file forever while one extra deletes a photo still on screen. Anything
unreferenced and less than six hours old is left alone, because that is a photo
sitting in a form that has not been submitted yet.

## Adding the next view

`VIEWS` in `public/app.js`, a `<button class="tab">` and a `<main class="frame">`
in `index.html`, a branch in `render()`, and a file under `data/`. The tab
routing, the save plumbing, the sheet overlay, the photo tray and the whole
stylesheet are already general.
