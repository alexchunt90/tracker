# Tracker

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
habitat, example photographs, edibility, lookalikes.

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
species either has or does not — which is what a key asks, and what a search
should answer.

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

## The Glossary

Every term the log knows, what it means, what it is classified as, and which
terms are treated as the same thing.

Definitions come from the field guide's own glossary where it has one, and are
written here where it does not; each says which. A term with no definition yet
is not an error — the Undefined filter is the writing queue, the same way
dashed grey tags are the vocabulary queue.

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

Pins are coloured by kingdom. Yours are solid; iNaturalist's are hollow,
smaller, and drawn underneath, so somebody else's identification can never be
mistaken for one of yours. Filter by type, by species, or to choice edibles
only.

Tiles are **proxied through this server and cached to disk**, which is the
reason for the proxy: the browser never talks to a tile server directly, so no
third party gets a running log of where you have been looking — and ground you
have already looked at still draws with no signal. When tiles cannot be
fetched at all, the map falls back to a graticule and says so; the pins are
still in the right places.

Delete `tiles/` to refresh the basemap.

## iNaturalist

Optional, on by default, and switched off with `inaturalist.enabled: false` in
`config.json`.

- **On the map** — research-grade observations from other people in the box you
  are looking at, as hollow pins. Narrowed to the kingdom you have filtered to,
  and to a single taxon when you pick a species that has been matched against
  iNaturalist. "Where does everyone else find chanterelles" is the question it
  answers.
- **In the species editor** — *Look up a name* searches their taxonomy and
  offers matches. Picking one fills in the common and scientific names and
  remembers the taxon id. It is **offered, never applied on its own**; the
  identification stays yours.

Their photographs are proxied too, through a host allowlist, so the page makes
no third-party requests at all. Responses are cached for five minutes because
panning re-asks constantly and their terms ask callers to be gentle. Set
`TRACKER_USER_AGENT` in `.env` to something with your contact address, which is
what they ask for.

If iNaturalist is unreachable the map says so quietly and carries on. Your own
pins are unaffected.

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
config.json          theme, map source, iNaturalist switch
data/
  observations.json  the finds
  species.json       the library
photos/              uploads, named by a minted id
tiles/               cached basemap
```

## Storage

Both collections are plain JSON arrays, written through a temp file and a
rename so an interrupted save leaves the previous file intact rather than a
truncated one.

Every record carries a `version`. The browser echoes back the one it loaded,
and a mismatch is rejected with a 409 — another tab or another device wrote
first, and silently discarding their edit is the one outcome worth refusing.
The browser reloads from disk and says so.

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
