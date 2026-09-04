/* ==========================================================================
   Field Notes — views and wiring. The log's rules live in model.js, and the
   photo-metadata reading in exif.js.

   The shape of the app follows the finances one: load everything in a single
   round trip, keep it in `state`, and re-render the whole active view after
   any change. At the scale of a personal log that is far cheaper than the
   bookkeeping a finer-grained update would need.
   ========================================================================== */

'use strict';

const VIEWS = ['log', 'species', 'glossary'];
const MODES = ['finds', 'map'];

const state = {
  config: null,
  observations: [],
  species: [],
  view: 'log',
  // View state, not saved: a filter is a way of looking at the log, not a
  // property of it.
  //
  // The gallery and the map are two renderings of one set of finds, so they
  // share one filter object. Filtering to chanterelles and then switching to
  // the map should show you those chanterelles, not start again.
  filters: { types: Model.TYPE_IDS.slice(), status: 'all', q: '', edibility: Model.EDIBILITY_IDS.slice(), speciesId: '' },
  // Which rendering is on screen. Read from the URL for the same reason the
  // tab is: a refresh should land where you were looking.
  mode: modeFromUrl(),
  speciesFilters: { type: 'all', q: '', tag: tagFromUrl() },
  // Sorted by binomial, which groups the library by genus — the Albatrellus
  // together, the Amanita together. The column shows the common name first
  // because that is what you would say; it orders by the name that files it.
  speciesSort: { col: 'scientificName', key: 'scientificName', dir: 'asc' },
  glossary: { version: 0, terms: {} },
  glossaryFilters: { category: 'all', state: 'all', q: '' },
  // Other people's records are fetched only for one species at a time, so
  // `speciesId` says whose they are and a stale set can be recognised.
  inat: { results: [], loading: false, problem: null, box: null, speciesId: null, taxa: new Map() },
  sheetDirty: false,
  closeSheet: null,
};

// The entry form's photo tray, built at boot. Lives outside `state` because a
// half-finished upload is not part of the log.
let obsTray = null;

// The map component, built the first time the Map tab is shown. Outside
// `state` because it owns DOM and a viewport, not data.
let mapView = null;

// --- formatting -------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2025-10-12T08:41" → "Oct 12 2025, 8:41 am". Parsed by hand, not by Date: */
/*  `new Date("2025-10-12T08:41")` is local but `new Date("2025-10-12")` is UTC,
    and the difference silently shifts a morning find to the day before. */
function fmtWhen(value, { time = true } = {}) {
  if (!value) return '—';
  const [date, clock] = String(value).split('T');
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) return '—';
  let out = `${MONTHS[Number(m) - 1] || '?'} ${Number(d)} ${y}`;
  if (time && clock) {
    const [rawHour, minute] = clock.split(':');
    const hour24 = Number(rawHour);
    const suffix = hour24 >= 12 ? 'pm' : 'am';
    out += `, ${hour24 % 12 || 12}:${minute} ${suffix}`;
  }
  return out;
}

const fmtDate = (value) => fmtWhen(value, { time: false });

/** Local wall-clock now, in the format a datetime-local input expects. */
function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * "1 find" / "2 finds". `many` is for anything that does not just take an -s;
 * a word that already ends in one is assumed to be its own plural, which is
 * what stops "species" becoming "speciess".
 */
const plural = (n, one, many) => {
  if (n === 1) return `${n} ${one}`;
  return `${n} ${many || (one.endsWith('s') ? one : one + 's')}`;
};
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// --- DOM helpers ------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/** A labelled form control, matching the markup `.entry-row` expects. */
function field(labelText, control, { hint, grow, wide } = {}) {
  const label = el('label', [grow && 'grow', wide && 'wide'].filter(Boolean).join(' ') || null);
  label.append(document.createTextNode(labelText), control);
  if (hint) label.append(el('span', 'field-hint', hint));
  return label;
}

function select(options, value, { placeholder } = {}) {
  const node = el('select');
  if (placeholder) node.append(new Option(placeholder, ''));
  for (const o of options) node.append(new Option(o.label, o.id));
  node.value = value ?? '';
  return node;
}

function input(type, value, attrs = {}) {
  const node = el('input');
  node.type = type;
  node.value = value ?? '';
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  return node;
}

/**
 * The scientific name, unless it is already what the heading says.
 *
 * Most species in a field guide have no vernacular name at all, so the display
 * name falls back to the binomial — and printing it twice, once bold and once
 * italic underneath, reads as a rendering fault rather than as a species with
 * no common name.
 */
function sciLine(displayName, scientificName, cls) {
  const sci = (scientificName || '').trim();
  if (!sci || sci === (displayName || '').trim().replace(/\?$/, '')) return null;
  return el('p', cls, sci);
}

const strongText = (text) => el('strong', null, text);

function typeBadge(type) {
  const badge = el('span', 'type-badge');
  badge.dataset.type = type;
  // The word is its own element so a narrow table can drop it and keep the
  // glyph, which already carries the meaning and the colour.
  badge.append(el('span', 'glyph', Model.typeGlyph(type)), el('span', 'type-label', Model.typeLabel(type)));
  return badge;
}

// --- notices and save status ------------------------------------------------

function notice(text) {
  const n = $('notice');
  if (!text) { n.hidden = true; return; }
  n.textContent = text;
  n.hidden = false;
}

let statusTimer = null;
function status(text) {
  $('save-status').textContent = text;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { $('save-status').textContent = ''; }, 1800);
}

// --- transport --------------------------------------------------------------

async function request(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

/**
 * Pull everything fresh and redraw. Used after a version conflict: another
 * device wrote first, so the safe move is to take their state rather than
 * merge two versions of a record automatically.
 */
async function reloadState() {
  const payload = await request('api/state', 'GET');
  state.config = payload.config;
  state.observations = payload.observations || [];
  state.species = payload.species || [];
  state.glossary = payload.glossary || { version: 0, terms: {} };
  Model.applyGlossary(state.glossary);
  invalidateUsage();
  applyTheme(state.config.theme);
  render();
}

/**
 * Save one record into its collection, keeping the local copy in step with the
 * version the server assigned. Returns true on success — callers use that to
 * decide whether to close an editor.
 */
async function saveRecord(kind, record) {
  const list = kind === 'species' ? state.species : state.observations;
  status('saving…');
  try {
    const payload = await request(`api/${kind}/${record.id}`, 'PUT', record);
    const at = list.findIndex((x) => x.id === record.id);
    // Take the server's copy, not the one just sent: it carries the version
    // the next save has to echo back.
    if (at === -1) list.push(payload.record); else list[at] = payload.record;
    invalidateUsage();
    notice('');
    status('saved');
    return true;
  } catch (err) {
    status('');
    if (err.status === 409) {
      notice(`${err.message}. Reloaded from disk — your last edit was not saved.`);
      await reloadState().catch(() => {});
    } else {
      notice(`Could not save: ${err.message}`);
    }
    return false;
  }
}

async function deleteRecord(kind, id) {
  status('deleting…');
  try {
    const payload = await request(`api/${kind}/${id}`, 'DELETE');
    const list = kind === 'species' ? state.species : state.observations;
    const at = list.findIndex((x) => x.id === id);
    if (at !== -1) list.splice(at, 1);
    invalidateUsage();
    notice('');
    status('deleted');
    // Observations keep pointing at a deleted species and read as unidentified
    // until re-linked. Say so, rather than letting finds quietly go blank.
    if (payload.orphaned) {
      notice(`Species deleted. ${plural(payload.orphaned, 'find')} that pointed at it now read as unidentified.`);
    }
    return true;
  } catch (err) {
    status('');
    notice(`Could not delete: ${err.message}`);
    return false;
  }
}

// --- theme ------------------------------------------------------------------

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  if (theme.accent) {
    root.setProperty('--accent', theme.accent);
    root.setProperty('--accent-wash', tint(theme.accent, 0.16));
    root.setProperty('--accent-dim', tint(theme.accent, 0.55));
  }
  for (const [type, colour] of Object.entries(theme.types || {})) {
    if (Model.TYPE_IDS.includes(type)) root.setProperty(`--${type}`, colour);
  }
  const app = state.config?.app;
  if (app?.title) {
    document.title = app.title;
    const h1 = $('masthead-title');
    clear(h1).append(document.createTextNode(app.title + ' '));
    if (app.emoji) {
      const glyph = el('span', 'masthead-emoji', app.emoji);
      glyph.setAttribute('role', 'img');
      h1.append(glyph);
    }
  }
}

/** "#A8C66C" at some opacity, as the rgba() the wash variables want. */
function tint(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return `rgba(168, 198, 108, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// --- routing ----------------------------------------------------------------

/**
 * The visible tab lives in ?view= so a refresh, a bookmark, or a link shared
 * to yourself lands where you left off.
 */
function viewFromUrl() {
  const asked = new URLSearchParams(location.search).get('view');
  return VIEWS.includes(asked) ? asked : 'log';
}

/** A term the Species view is filtered to, named in the URL so it can be linked. */
function tagFromUrl() {
  return (new URLSearchParams(location.search).get('tag') || '').trim();
}

function modeFromUrl() {
  const asked = new URLSearchParams(location.search).get('mode');
  return MODES.includes(asked) ? asked : 'finds';
}

/**
 * Both routing facts in one URL, so neither can drop the other on the way
 * past. The default mode stays out of it — `?view=species&mode=finds` says
 * nothing you could not have guessed.
 */
function routeUrl() {
  const url = new URL(location.href);
  url.searchParams.set('view', state.view);
  if (state.mode === 'finds') url.searchParams.delete('mode');
  else url.searchParams.set('mode', state.mode);
  // Only meaningful on the Species view, and only when set.
  if (state.view === 'species' && state.speciesFilters.tag) {
    url.searchParams.set('tag', state.speciesFilters.tag);
  } else {
    url.searchParams.delete('tag');
  }
  return url;
}

const routeState = () => ({ view: state.view, mode: state.mode });

/** Gallery or map. The same routing contract the tabs get. */
function setMode(mode, { push = true } = {}) {
  state.mode = MODES.includes(mode) ? mode : 'finds';
  if (push) history.pushState(routeState(), '', routeUrl());
  render();
}

function setView(view, { push = true } = {}) {
  state.view = VIEWS.includes(view) ? view : 'log';
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.view === state.view);
    tab.setAttribute('aria-selected', tab.dataset.view === state.view ? 'true' : 'false');
  }
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== state.view;
  // A map built or drawn while its tab was hidden measured a zero-width box.
  if (state.view === 'map' && mapView) requestAnimationFrame(() => mapView.redraw());
  if (push) history.pushState(routeState(), '', routeUrl());
  render();
}

// --- photos -----------------------------------------------------------------

// Types a browser will render in an <img>. HEIC is deliberately absent: Safari
// decodes it, but nothing else does, so it cannot be relied on for a preview.
const DISPLAYABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  tif: 'image/tiff', tiff: 'image/tiff',
};

// The types the server will accept, derived from the table above so the two
// can never disagree.
const SUPPORTED = new Set(Object.values(BY_EXTENSION));

/** Some pickers hand over a File with an empty `type`; the name still tells us. */
function mimeOf(file) {
  const given = (file.type || '').toLowerCase();
  if (given) return given;
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return BY_EXTENSION[ext] || '';
}

// What to show in a grid cell, and what to show at full size. They differ:
// the stored original is the better picture, but only if the browser can
// actually decode it — otherwise the generated preview is all there is.
const thumbSrc = (p) => (p?.thumb ? `photos/${p.thumb}` : p && DISPLAYABLE.has(p.mime) ? `photos/${p.file}` : null);
const fullSrc = (p) => (p && DISPLAYABLE.has(p.mime) ? `photos/${p.file}` : p?.thumb ? `photos/${p.thumb}` : null);

const coverOf = (record) => (record?.photos || [])[0] || null;

/**
 * A downscaled JPEG preview, made in the browser before upload.
 *
 * Two jobs. It keeps the gallery from pulling twenty 4MB originals over the
 * network, and on Safari — which decodes HEIC — it is what makes an iPhone
 * HEIC visible in every *other* browser later, because the preview is a plain
 * JPEG. Returns null when the browser cannot decode the file at all, which is
 * an ordinary outcome, not a failure: the original is still stored.
 */
async function makePreview(file) {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap;
  try {
    // from-image so a portrait phone shot is baked upright, rather than
    // relying on every future consumer to read the orientation tag.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const MAX = 1000;
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = el('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ? { blob, width: bitmap.width, height: bitmap.height } : null;
  } catch {
    return null;
  } finally {
    bitmap.close?.();
  }
}

async function uploadBlob(blob, mime) {
  const res = await fetch('api/photos', { method: 'POST', headers: { 'Content-Type': mime }, body: blob });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

/**
 * Read one file's metadata, build its preview, and store both.
 *
 * The EXIF is read from the very buffer that gets uploaded, so what the form
 * displays and what the server holds cannot drift apart.
 */
async function ingestPhoto(file) {
  const mime = mimeOf(file);
  if (!SUPPORTED.has(mime)) throw new Error(mime ? `${mime} is not a supported image` : 'unrecognised file type');

  const buffer = await file.arrayBuffer();
  const meta = Exif.read(buffer);
  const preview = await makePreview(file);

  const stored = await uploadBlob(new Blob([buffer], { type: mime }), mime);
  let thumb = null;
  if (preview) {
    // A failed preview upload must not lose the original, which is already
    // safely stored — the photo just falls back to being served full size.
    thumb = await uploadBlob(preview.blob, 'image/jpeg').then((r) => r.file).catch(() => null);
  }

  return {
    file: stored.file,
    thumb,
    name: file.name || 'photo',
    mime,
    bytes: stored.bytes,
    width: meta.width || preview?.width || null,
    height: meta.height || preview?.height || null,
    takenAt: meta.takenAt,
    offset: meta.offset,
    lat: meta.lat,
    lon: meta.lon,
    altitude: meta.altitude,
    make: meta.make,
    model: meta.model,
    hasExif: meta.hasExif,
  };
}

// --- metadata adoption ------------------------------------------------------

/**
 * Fill the empty fields of the entry form from the photos.
 *
 * Only ever fills a blank. A typed correction has to survive dropping a second
 * photo in, or the form fights the person using it — and the photo's own
 * reading is the thing more likely to be wrong (a camera clock left on the
 * wrong zone, a GPS fix taken back at the trailhead).
 */
function adoptMetadata(photos) {
  const dated = photos.filter((p) => p.takenAt).sort((a, b) => a.takenAt.localeCompare(b.takenAt))[0];
  const placed = photos.find((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (dated && !$('obs-when').value) {
    $('obs-when').value = dated.takenAt;
    $('obs-when-hint').textContent = 'From the photo.';
  }
  if (placed && !$('obs-lat').value && !$('obs-lon').value) {
    $('obs-lat').value = placed.lat;
    $('obs-lon').value = placed.lon;
  }
}

function shotCard(shot, onRemove, onOpen) {
  const card = el('div', 'shot' + (shot.status === 'working' ? ' is-busy' : ''));
  // A button only when there is something to enlarge: an upload still being
  // read has nothing behind it, and a dead control that looks alive is worse
  // than a plain frame.
  const frame = el(onOpen && shot.photo ? 'button' : 'div', 'shot-frame');
  if (onOpen && shot.photo) {
    frame.type = 'button';
    frame.title = shot.photo.attribution || 'View full size';
    frame.addEventListener('click', onOpen);
  }

  const src = shot.photo ? thumbSrc(shot.photo) : null;
  if (src) {
    const img = el('img');
    img.src = src;
    img.alt = shot.name;
    img.loading = 'lazy';
    frame.append(img);
  } else {
    frame.append(el('span', 'no-preview', shot.status === 'failed' ? '⚠' : '🖼'));
  }
  card.append(frame);

  const meta = el('div', 'shot-meta');
  if (shot.status === 'working') {
    meta.textContent = 'reading…';
  } else if (shot.status === 'failed') {
    meta.textContent = shot.error || 'failed';
  } else {
    const p = shot.photo;
    const bits = [];
    if (p.takenAt) bits.push(fmtWhen(p.takenAt));
    if (Number.isFinite(p.lat)) bits.push(Model.formatCoord(p.lat, p.lon));
    if (!bits.length && !p.attribution) bits.push('no EXIF');
    bits.push(fmtBytes(p.bytes));
    for (const [i, text] of bits.entries()) {
      const line = el('div', i < bits.length - 1 && p.hasExif ? 'has' : null, text);
      meta.append(line);
    }
    /*
     * Somebody else's photograph carries their name. Every borrowed reference
     * shot here is under a Creative Commons licence, and those licences are
     * granted on condition of credit \u2014 so the credit is not decoration, it is
     * the terms. It links back to the observation it came from.
     */
    if (p.attribution) {
      const credit = p.sourceUrl ? el('a', 'shot-credit') : el('div', 'shot-credit');
      credit.textContent = p.attribution;
      credit.title = p.attribution + (p.licence ? ` \u2014 ${p.licence}` : '');
      if (p.sourceUrl) {
        credit.href = p.sourceUrl;
        credit.target = '_blank';
        credit.rel = 'noopener noreferrer';
      }
      meta.append(credit);
    }
  }
  card.append(meta);

  if (shot.status === 'working') card.append(el('div', 'shot-progress'));

  const drop = el('button', 'shot-drop', '×');
  drop.type = 'button';
  drop.title = 'Remove';
  drop.setAttribute('aria-label', `Remove ${shot.name}`);
  drop.addEventListener('click', onRemove);
  card.append(drop);

  return card;
}

/**
 * Wire a dropzone to a hidden file input. Used by the entry form and by the
 * species editor, which take photos the same way.
 */
function wireDropzone(zone, fileInput, onFiles) {
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    onFiles(fileInput.files);
    // Reset so choosing the same file twice still fires a change event.
    fileInput.value = '';
  });
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (ev) => { ev.preventDefault(); zone.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (ev) => { ev.preventDefault(); zone.classList.remove('is-over'); });
  }
  zone.addEventListener('drop', (ev) => {
    const files = Array.from(ev.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/') || BY_EXTENSION[f.name.split('.').pop().toLowerCase()]);
    if (files.length) onFiles(files);
  });
}

// --- rendering --------------------------------------------------------------

/** Everything derived from state, computed once per render. */
function derive() {
  const rows = Model.viewAll(state.observations, state.species);
  return { rows, summary: Model.summary(rows), life: Model.lifeList(state.species, rows) };
}

function render() {
  const d = derive();
  renderMasthead(d);
  if (state.view === 'log') renderLog(d);
  else if (state.view === 'glossary') renderGlossary(d);
  else renderSpecies(d);
}

function renderMasthead({ rows, summary: s, life }) {
  $('chip-finds').textContent = s.total;
  $('chip-identified').textContent = s.total ? `${Math.round(s.identifiedShare * 100)}%` : '—';
  $('chip-identified-source').textContent = s.total ? `${s.identified} of ${s.total}` : 'nothing logged yet';
  // The size of the library, not the number met. The met count is already the
  // subject of the Identified chip beside it, and the library is the number
  // that answers "is this thing in here" — which is what the chip is for.
  $('chip-species').textContent = life.length;
  $('chip-species-source').textContent = `${s.speciesSeen} met in the field`;

  const last = s.latest;
  $('chip-last').textContent = last ? last.name : '—';
  $('chip-last-source').textContent = last ? (last.when ? fmtDate(last.when) : 'undated') : 'no finds yet';
}

// --- the log view -----------------------------------------------------------

function renderLog({ rows }) {
  renderFilters(rows);
  const shown = Model.sortByDate(Model.filter(rows, state.filters));

  $('mode-finds').classList.toggle('is-on', state.mode === 'finds');
  $('mode-map').classList.toggle('is-on', state.mode === 'map');
  $('mode-finds').setAttribute('aria-selected', String(state.mode === 'finds'));
  $('mode-map').setAttribute('aria-selected', String(state.mode === 'map'));
  $('finds-gallery').hidden = state.mode !== 'finds';
  $('map-pane').hidden = state.mode !== 'map';

  const picked = selectedSpecies();
  const wantedNotFound = picked && !rows.some((r) => r.species?.id === picked.id);
  $('finds-note').textContent = wantedNotFound
    ? `You have not logged ${picked.commonName || picked.scientificName} yet.`
    : !state.filters.types.length
      ? 'No types selected — tick one to see your finds.'
      : shown.length === rows.length
        ? `${plural(rows.length, 'find')}, newest first.`
        : `${shown.length} of ${rows.length} finds.`;

  if (state.mode === 'finds') renderGallery(shown, rows);
  else renderMap(shown, rows);

  renderFindsVerdict(shown, rows);
}

// --- filters ----------------------------------------------------------------

function renderFilters(rows) {
  const counts = Model.summary(rows).counts;
  const sum = Model.summary(rows);

  // Changing what is shown is also a new question for iNaturalist, not just a
  // redraw of what is already here.
  const refresh = () => { loadInat(); render(); };

  const typeSet = clear($('filter-type'));
  typeSet.append(typeDropdown(counts, refresh));

  const statusSet = clear($('filter-status'));
  statusSet.append(statusDropdown(sum, refresh));

  const extra = clear($('filter-extra'));
  extra.append(edibilityDropdown(Model.edibilityCounts(rows), refresh));
  /*
   * What the picker offers: species you have found, and the choice edibles.
   *
   * Found species filter your own finds. A choice edible you have not found
   * yet filters nothing — it is there to ask iNaturalist where other people
   * are finding it, which is the question worth asking about a species you
   * want and do not have. Grouped, so the two kinds are not confused.
   */
  const picker = $('filter-species');
  const held = state.filters.speciesId;
  clear(picker);
  picker.append(new Option('Any species', ''));

  const seen = new Map();
  for (const r of rows) if (r.species) seen.set(r.species.id, (seen.get(r.species.id) || 0) + 1);

  // The type filter narrows this too. Offering a fungus while the view is
  // filtered to Flora would produce a picker whose every choice empties the
  // page.
  const ofType = (sp) => state.filters.types.includes(sp.kind);
  const found = state.species.filter((sp) => seen.has(sp.id) && ofType(sp));
  const wanted = state.species.filter((sp) => Model.isChoice(sp) && !seen.has(sp.id) && ofType(sp));
  const label = (sp) => sp.commonName || sp.scientificName || 'Unnamed';
  const byName = (a, b) => label(a).localeCompare(label(b));

  if (found.length) {
    const group = document.createElement('optgroup');
    group.label = 'Found';
    for (const sp of [...found].sort(byName)) group.append(new Option(`${label(sp)} (${seen.get(sp.id)})`, sp.id));
    picker.append(group);
  }
  if (wanted.length) {
    const group = document.createElement('optgroup');
    group.label = 'Choice edibles, not yet found';
    for (const sp of [...wanted].sort(byName)) group.append(new Option(label(sp), sp.id));
    picker.append(group);
  }

  picker.value = held;
  if (picker.selectedIndex === -1) { picker.value = ''; state.filters.speciesId = ''; }
  $('filter-species-wrap').hidden = !found.length && !wanted.length;
}

/** One sentence about what is on screen. */
function renderFindsVerdict(shown, rows) {
  const node = clear($('finds-verdict'));
  if (!rows.length) {
    node.textContent = 'Nothing logged yet. A photo is enough to start — the species can wait.';
    return;
  }
  if (state.inat.problem && state.mode === 'map' && selectedSpecies()) {
    node.append(strongText(state.inat.problem), document.createTextNode(' Your own finds are unaffected.'));
    return;
  }
  const picked = selectedSpecies();
  if (picked && !rows.some((r) => r.species?.id === picked.id)) {
    const name = picked.commonName || picked.scientificName;
    if (state.mode === 'map') {
      node.append(
        strongText(state.inat.results.length
          ? `${plural(state.inat.results.length, 'record')} of ${name} from other people.`
          : `No records of ${name} from other people in view.`),
        document.createTextNode(' None of your own — pan or zoom out to widen the search.'));
    } else {
      node.append(strongText(`You have not found ${name} yet.`),
        document.createTextNode(' Switch to the map to see where other people have.'));
    }
    return;
  }

  const sum = Model.summary(shown);
  const parts = [];
  if (sum.unidentified) parts.push(`${plural(sum.unidentified, 'find')} still unidentified`);
  if (sum.uncertain) parts.push(`${plural(sum.uncertain, 'identification')} marked uncertain`);
  if (state.mode === 'map') {
    const off = shown.length - sum.placed;
    node.append(strongText(`${plural(sum.placed, 'pin')} on the map.`),
      document.createTextNode(off ? ` ${off} without a location, not shown.` : ''));
    const picked = selectedSpecies();
    if (picked && state.inat.results.length) {
      node.append(document.createTextNode(
        ` ${plural(state.inat.results.length, 'record')} of it from other people, as triangles that fade with age.`));
    } else if (!picked) {
      node.append(document.createTextNode(' Pick a species to see where other people have found it.'));
    }
    return;
  }
  node.append(parts.length ? strongText(parts.join(', ') + '.') : strongText('Everything shown is identified and settled.'),
    document.createTextNode(` ${sum.placed} of ${shown.length} carry a location.`));
}

/**
 * The type filter, as a dropdown of checkboxes.
 *
 * Three pills where only one could be lit made "fungi and flora, but not
 * fauna" unsayable. Unchecking everything is allowed and means nothing is
 * shown — snapping back to "all" would quietly do the opposite of what was
 * asked.
 */
function typeDropdown(counts, onChange) {
  const wrap = el('div', 'dropdown');
  const chosen = state.filters.types;

  const button = el('button', 'dropdown-button');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');

  const label = chosen.length === Model.TYPE_IDS.length ? 'All types'
    : !chosen.length ? 'No types'
      : Model.TYPES.filter((t) => chosen.includes(t.id)).map((t) => t.label).join(', ');
  button.append(el('span', 'dropdown-label', label));
  const total = Model.TYPE_IDS.filter((t) => chosen.includes(t)).reduce((n, t) => n + (counts[t] || 0), 0);
  button.append(el('span', 'count', String(total)));
  button.append(el('span', 'dropdown-caret', '▾'));
  if (!chosen.length) button.classList.add('is-empty');
  wrap.append(button);

  const menu = el('div', 'dropdown-menu');
  menu.hidden = true;
  for (const t of Model.TYPES) {
    const row = el('label', 'dropdown-option');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = chosen.includes(t.id);
    box.addEventListener('change', () => {
      const next = new Set(state.filters.types);
      if (box.checked) next.add(t.id); else next.delete(t.id);
      // Keep a stable order so the button label does not reshuffle.
      state.filters.types = Model.TYPE_IDS.filter((id) => next.has(id));
      onChange();
    });
    const badge = typeBadge(t.id);
    row.append(box, badge, el('span', 'count', String(counts[t.id] || 0)));
    menu.append(row);
  }

  const all = el('button', 'dropdown-all');
  all.type = 'button';
  all.textContent = chosen.length === Model.TYPE_IDS.length ? 'Clear all' : 'Select all';
  all.addEventListener('click', () => {
    state.filters.types = chosen.length === Model.TYPE_IDS.length ? [] : Model.TYPE_IDS.slice();
    onChange();
  });
  menu.append(all);
  wrap.append(menu);

  wireDropdown(wrap, button, menu);
  return wrap;
}

/**
 * How settled the identification is, as a dropdown of one choice.
 *
 * Unlike types, these do not combine: identified and unidentified are
 * complements, and uncertain is a slice of identified, so "identified and
 * uncertain" would only ever mean "identified". Radios, not checkboxes, and
 * picking one closes the menu \u2014 there is nothing else to say.
 */
/**
 * One choice from a short list, as a dropdown.
 *
 * The pill rows this replaced read as a set of toggles when only one could
 * ever be lit. Radios say "pick one" without a caption explaining it, and a
 * closed dropdown costs one line instead of five — which is what lets the
 * Species and Glossary filter bars sit on a single row beside their search.
 *
 * `options` is [{ id, label, count, mark }]; `mark` is an optional element
 * shown before the label, so a type keeps its badge and a category its colour.
 */
function choiceDropdown({ name, options, current, onPick, label }) {
  const held = options.find((o) => o.id === current) || options[0];

  const wrap = el('div', 'dropdown');
  const button = el('button', 'dropdown-button');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  if (label) button.setAttribute('aria-label', `${label}: ${held.label}`);
  button.append(el('span', 'dropdown-label', held.label));
  if (held.count != null) button.append(el('span', 'count', String(held.count)));
  button.append(el('span', 'dropdown-caret', '\u25be'));
  wrap.append(button);

  const menu = el('div', 'dropdown-menu');
  menu.hidden = true;
  for (const o of options) {
    const row = el('label', 'dropdown-option' + (o.id === held.id ? ' is-on' : ''));
    const dot = el('input');
    dot.type = 'radio';
    dot.name = name;
    dot.checked = o.id === held.id;
    dot.addEventListener('change', () => {
      close();
      onPick(o.id);
    });
    row.append(dot);
    if (o.mark) row.append(o.mark);
    // A badge already carries its own text; printing the label after it reads
    // as "Fungi Fungi". The button still uses `label`, which is plain words.
    if (!o.mark || !o.markIsLabel) row.append(el('span', 'dropdown-option-label', o.label));
    if (o.count != null) row.append(el('span', 'count', String(o.count)));
    menu.append(row);
  }
  wrap.append(menu);

  const close = wireDropdown(wrap, button, menu);
  return wrap;
}

/** How settled the identification is. One of four, so one choice. */
function statusDropdown(sum, onChange) {
  return choiceDropdown({
    name: 'filter-status',
    label: 'Identification',
    current: state.filters.status,
    onPick: (id) => { state.filters.status = id; onChange(); },
    options: [
      { id: 'all', label: 'Any ID', count: sum.total },
      { id: 'identified', label: 'Identified', count: sum.identified },
      { id: 'unidentified', label: 'Unidentified', count: sum.unidentified },
      { id: 'uncertain', label: 'Uncertain', count: sum.uncertain },
    ],
  });
}

/**
 * The edibility tiers, as a dropdown of checkboxes.
 *
 * Checkboxes rather than one choice, because unlike the ID filter these
 * genuinely combine: "choice or edible" is the forager's question and "toxic
 * or deadly" is the cautionary one, and neither is a single tier. Seven of
 * them would make seven pills, which is why this was a lone "choice edible"
 * toggle before \u2014 the tiers were there, just unreachable.
 */
function edibilityDropdown(counts, onChange) {
  const wrap = el('div', 'dropdown');
  const chosen = state.filters.edibility;
  const all = chosen.length === Model.EDIBILITY_IDS.length;
  const name = (e) => (e.id === 'unknown' ? 'Not recorded' : e.short);

  const button = el('button', 'dropdown-button');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');

  // Seven short labels joined would outrun the filter bar, so past a couple
  // the button counts them instead of naming them.
  const picked = Model.EDIBILITY.filter((e) => chosen.includes(e.id));
  const label = all ? 'Any edibility'
    : !picked.length ? 'No tiers'
      : picked.length <= 2 ? picked.map(name).join(', ')
        : `${picked.length} tiers`;
  button.append(el('span', 'dropdown-label', label));
  button.append(el('span', 'count', String(picked.reduce((n, e) => n + (counts[e.id] || 0), 0))));
  button.append(el('span', 'dropdown-caret', '\u25be'));
  if (!picked.length) button.classList.add('is-empty');
  wrap.append(button);

  const menu = el('div', 'dropdown-menu');
  menu.hidden = true;
  for (const e of Model.EDIBILITY) {
    const row = el('label', 'dropdown-option');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = chosen.includes(e.id);
    box.addEventListener('change', () => {
      const next = new Set(state.filters.edibility);
      if (box.checked) next.add(e.id); else next.delete(e.id);
      // Keep tier order, so the button label reads worst-to-best consistently.
      state.filters.edibility = Model.EDIBILITY_IDS.filter((id) => next.has(id));
      onChange();
    });
    row.append(box, edibleBadge(e.id), el('span', 'count', String(counts[e.id] || 0)));
    menu.append(row);
  }

  const toggle = el('button', 'dropdown-all');
  toggle.type = 'button';
  toggle.textContent = all ? 'Clear all' : 'Select all';
  toggle.addEventListener('click', () => {
    state.filters.edibility = all ? [] : Model.EDIBILITY_IDS.slice();
    onChange();
  });
  menu.append(toggle);
  wrap.append(menu);

  wireDropdown(wrap, button, menu);
  return wrap;
}

/**
 * The open/close half of a dropdown: toggle on the button, close on a click
 * outside or on Escape. Returns the closer so a menu that settles a question
 * in one click can shut itself.
 */
function wireDropdown(wrap, button, menu) {
  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onKey);
  };
  const onOutside = (ev) => { if (!wrap.contains(ev.target)) close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') { close(); button.focus(); } };
  button.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      document.addEventListener('mousedown', onOutside);
      document.addEventListener('keydown', onKey);
    } else {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
    }
  });
  return close;
}


// --- gallery ----------------------------------------------------------------

function renderGallery(shown, rows) {
  const gallery = clear($('finds-gallery'));
  if (!shown.length) {
    gallery.append(el('div', 'empty-state', rows.length ? 'No finds match these filters.' : 'The log is empty. Log a find above.'));
    return;
  }
  for (const row of shown) gallery.append(findCard(row));
}

function findCard(row) {
  const card = el('button', 'find');
  card.type = 'button';

  const frame = el('div', 'find-frame');
  const src = thumbSrc(coverOf(row));
  if (src) {
    const img = el('img');
    img.src = src;
    img.alt = row.name;
    img.loading = 'lazy';
    frame.append(img);
  } else {
    frame.append(el('span', 'no-preview', Model.typeGlyph(row.type)));
  }
  card.append(frame);

  const body = el('div', 'find-body');
  body.append(typeBadge(row.type));
  body.append(el('h3', 'find-name' + (row.identified ? '' : ' is-unknown'), row.name));
  const sci = sciLine(row.name, row.scientificName, 'find-sci sci');
  if (sci) body.append(sci);

  const bits = [fmtDate(row.when)];
  if (row.hasPlace) bits.push(Model.formatCoord(row.lat, row.lon));
  else if (row.place) bits.push(row.place);
  body.append(el('p', 'find-meta', bits.join(' · ')));

  const marks = el('div', 'find-marks');
  if (Model.isChoice(row.species)) {
    const dot = el('span', 'find-mark is-choice');
    dot.title = 'Choice edible';
    marks.append(dot, el('span', 'find-count', 'Choice'));
  } else if (Model.isDangerous(row.species)) {
    const dot = el('span', 'find-mark is-dangerous');
    dot.title = Model.edibility(row.species.edibility).label;
    marks.append(dot, el('span', 'find-count', Model.edibility(row.species.edibility).label));
  } else if (Model.isDubious(row.species)) {
    const dot = el('span', 'find-mark is-dubious');
    dot.title = 'Dubious — eaten by some, not tolerated by others';
    marks.append(dot, el('span', 'find-count', 'Dubious'));
  }
  const extra = (row.photos || []).length;
  if (extra > 1) marks.append(el('span', 'find-count', `${extra} photos`));
  if (marks.children.length) body.append(marks);

  card.append(body);
  // An unidentified find has one obvious next action, so the card performs it
  // rather than making you open the record and go looking for the button.
  card.addEventListener('click', () => {
    if (row.identified) openObservationSheet(row.id);
    else openIdentifySheet(row.id);
  });
  return card;
}

// --- the map ----------------------------------------------------------------

/*
 * What a pin is, on hover.
 *
 * A map of forty pins answers "where" and nothing else — telling them apart
 * meant clicking each one open and closing it again. The photograph is what
 * actually identifies a find at a glance; the date is what separates two
 * visits to the same patch.
 *
 * Shorter delay than the glossary tooltip: a pin is a small target you aim at
 * deliberately, so a full second reads as lag rather than restraint.
 */
const PIN_TIP_DELAY = 250;
let pinTipTimer = null;
let pinTipNode = null;

function hidePinTip() {
  clearTimeout(pinTipTimer);
  if (pinTipNode) pinTipNode.hidden = true;
}

function showPinTip(pin, marker) {
  if (!pinTipNode) {
    pinTipNode = el('div', 'pin-tip');
    pinTipNode.hidden = true;
    document.body.append(pinTipNode);
  }
  const tip = clear(pinTipNode);

  const own = pin.kind === 'mine';
  const row = pin.row;
  const inat = pin.inat;

  // The photograph, which is what tells two brown mushrooms apart.
  const photo = own ? coverOf(row) : null;
  const src = own ? (thumbSrc(photo) || fullSrc(photo)) : (inat?.photo || null);
  if (src) {
    const frame = el('div', 'pin-tip-shot');
    const img = el('img');
    img.src = src;
    img.alt = '';
    frame.append(img);
    tip.append(frame);
  }

  const body = el('div', 'pin-tip-body');
  const name = own ? row.name : (inat?.commonName || inat?.scientificName || 'iNaturalist record');
  const heading = el('div', 'pin-tip-name' + (own && !row.identified ? ' is-unknown' : ''), name);
  body.append(heading);

  const sci = own ? row.scientificName : (inat?.commonName ? inat.scientificName : '');
  if (sci && sci !== name) body.append(el('div', 'pin-tip-sci sci', sci));

  const when = own ? row.when : inat?.observedOn;
  const line = el('div', 'pin-tip-meta');
  line.append(el('span', null, when ? fmtDate(when) : 'undated'));
  if (own && (row.photos || []).length > 1) {
    line.append(el('span', 'pin-tip-count', `${row.photos.length} photos`));
  }
  if (!own) line.append(el('span', 'pin-tip-count', 'iNaturalist'));
  body.append(line);

  if (own && Model.isDangerous(row.species)) {
    body.append(el('div', 'pin-tip-warn', Model.edibility(row.species.edibility).label));
  }
  tip.append(body);

  placeTip(tip, marker.getBoundingClientRect(), { gap: 10, centre: true });
}

/** Pins are the map's own shape: position, how to draw it, what to say. */
function ownPins(rows) {
  return rows.filter((r) => r.hasPlace).map((r) => ({
    id: r.id,
    kind: 'mine',
    lat: r.lat,
    lon: r.lon,
    type: r.type,
    label: `${r.name} — ${fmtDate(r.when)}`,
    // Fungi only: it is the group where edibility is the thing you want to
    // read off a map at a glance. Flora and fauna keep their type colour.
    edibility: r.type === 'fungi' ? Model.findEdibility(r) : '',
    row: r,
  }));
}

function inatPins(results, edibility) {
  return results.map((o) => ({
    id: o.id,
    kind: 'inat',
    lat: o.lat,
    lon: o.lon,
    type: o.type,
    label: `${o.commonName || o.scientificName} — iNaturalist`,
    // Other people's records only load for one species at a time, so they all
    // share that species' tier \u2014 the same colour as your own finds of it.
    edibility: o.type === 'fungi' ? edibility : '',
    // Old sightings fade. Where a species was six years ago is worth knowing;
    // it is just not worth as much as where it was last week.
    opacity: Model.ageOpacity(o.observedOn),
    inat: o,
  }));
}

/**
 * The map, drawn from the same filtered rows the gallery would show.
 *
 * A pin does what a card does: opens the find. There is no separate selection
 * panel any more — it was a second way of looking at one record, and the
 * record already has a good one.
 */
function renderMap(shown, rows) {
  const placed = shown.filter((r) => r.hasPlace);

  if (!mapView) {
    const config = state.config?.map || {};
    mapView = MapView.create({
      node: $('map-canvas'),
      attribution: config.attribution || '',
      minZoom: config.minZoom ?? 2,
      maxZoom: config.maxZoom ?? 19,
      onSelect: (pin) => {
        if (pin.kind === 'mine') {
          if (pin.row.identified) openObservationSheet(pin.row.id);
          else openIdentifySheet(pin.row.id);
        } else {
          openInatSheet(pin.inat);
        }
      },
      onViewChange: (box) => { state.inat.box = box; loadInat(); },
      onHover: (pin, marker) => {
        clearTimeout(pinTipTimer);
        if (!pin) return hidePinTip();
        // A beat, so sweeping the cursor across a cluster does not strobe.
        pinTipTimer = setTimeout(() => showPinTip(pin, marker), PIN_TIP_DELAY);
      },
    });
    const start = config.default || { lat: 0, lon: 0, zoom: 2 };
    const found = MapView.fitBounds(placed, $('map-canvas').clientWidth || 800, $('map-canvas').clientHeight || 420, { maxZoom: config.maxZoom ?? 19 });
    mapView.setView(found || start, { silent: true });
    state.inat.box = mapView.bounds();
  }

  const picked = selectedSpecies();
  mapView.setPins([...ownPins(placed), ...inatPins(state.inat.results, picked?.edibility || 'unknown')]);
  // A tile layer drawn while the pane was hidden measured a zero-width box.
  requestAnimationFrame(() => mapView.redraw());
  renderMapLegend(placed);
  void rows;
}

/**
 * A pin swatch drawn the same way the map draws it, so the key cannot drift
 * from the thing it explains.
 */
function pinSwatch(kind, edibility, type) {
  const swatch = el('span', `legend-pin map-pin is-${kind}`);
  if (type) swatch.dataset.type = type;
  if (edibility) swatch.dataset.edibility = edibility;
  swatch.append(MapView.pinShape(kind));
  return swatch;
}

function renderMapLegend(shown) {
  const legend = clear($('map-legend'));
  for (const t of Model.TYPES) {
    const n = shown.filter((r) => r.type === t.id).length;
    const item = el('div', 'legend-item' + (n ? '' : ' is-zero'));
    item.append(pinSwatch('mine', '', t.id), document.createTextNode(t.label), el('span', 'legend-value', String(n)));
    legend.append(item);
  }

  /*
   * The edibility key, listing only the tiers actually on screen. A full
   * seven-tier key would be mostly noise on a map showing three pins, and the
   * tiers that are absent are the ones you least need explained.
   */
  const fungi = shown.filter((r) => r.type === 'fungi');
  const present = Model.EDIBILITY.filter((e) => fungi.some((r) => Model.findEdibility(r) === e.id));
  if (present.length > 1) {
    const item = el('div', 'legend-item legend-tiers');
    for (const e of present) {
      const one = el('span', 'legend-tier');
      one.append(pinSwatch('mine', e.id, 'fungi'),
        document.createTextNode(e.id === 'unknown' ? 'Not recorded' : e.short));
      item.append(one);
    }
    legend.append(item);
  }

  const picked = selectedSpecies();
  if (picked) {
    const item = el('div', 'legend-item');
    const name = picked.commonName || picked.scientificName;
    item.append(pinSwatch('inat', picked.kind === 'fungi' ? picked.edibility || 'unknown' : '', picked.kind),
      document.createTextNode(
        state.inat.loading ? `Looking up ${name} on iNaturalist\u2026` : `Triangles: ${name} found by others, research grade`),
      el('span', 'legend-value', String(state.inat.results.length)));
    legend.append(item);
  }
}

/** Somebody else's record, read-only, in the same sheet the app uses for finds. */
function openInatSheet(o) {
  openSheet((sheet, close) => {
    sheetHead(sheet, o.commonName || o.scientificName, o.scientificName, close);
    const shown = sheetSection(sheet);
    shown.append(el('span', 'source-tag', 'iNaturalist · someone else'));
    if (o.photo) {
      const hero = el('div', 'sheet-hero');
      const img = el('img');
      img.src = o.photo;
      img.alt = '';
      img.addEventListener('error', () => { clear(hero).append(el('span', 'no-preview', Model.typeGlyph(o.type))); }, { once: true });
      hero.append(img);
      shown.append(hero);
    }
    const facts = sheetSection(sheet, 'The record');
    const list = el('dl', 'facts');
    const add = (t, v) => { if (!v) return; const w = el('div'); w.append(el('dt', null, t)); const dd = el('dd'); dd.append(typeof v === 'string' ? document.createTextNode(v) : v); w.append(dd); list.append(w); };
    add('Type', Model.typeLabel(o.type));
    add('Observed', o.observedOn ? fmtDate(o.observedOn) : null);
    add('By', o.by);
    add('Position', Model.formatCoord(o.lat, o.lon) + (o.obscured ? ' (obscured)' : ''));
    facts.append(list);

    const actions = el('div', 'form-actions');
    actions.append(externalLink(o.url, 'Open on iNaturalist'));
    const adopt = el('button', 'solid-button', 'Add as species');
    adopt.type = 'button';
    adopt.addEventListener('click', () => {
      openSpeciesSheet(null, { kind: o.type, seed: { commonName: o.commonName || '', scientificName: o.scientificName || '' } });
    });
    actions.append(adopt);
    sheet.append(actions);
  });
}

function externalLink(href, text) {
  const a = el('a', 'ghost-button', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.textDecoration = 'none';
  return a;
}

function edibleBadge(id) {
  const meta = Model.edibility(id);
  const badge = el('span', 'edible-badge', meta.short === '—' ? 'Not recorded' : meta.label);
  badge.dataset.edibility = meta.id;
  return badge;
}

const selectedSpecies = () =>
  (state.filters.speciesId ? state.species.find((sp) => sp.id === state.filters.speciesId) : null) || null;

/**
 * Every iNaturalist taxon that means this species.
 *
 * The imported library carries names, not ids, so almost nothing has one
 * stored — resolving on demand is what makes this work for four hundred
 * species rather than the handful matched by hand. A species can resolve to
 * more than one taxon, because a guide and iNaturalist can disagree about the
 * accepted name; both sets of records are that species' records.
 *
 * Cached for the session. Nothing is written back to the library, because
 * browsing a map should not quietly edit your records.
 */
async function resolveTaxa(species) {
  if (state.inat.taxa.has(species.id)) return state.inat.taxa.get(species.id);

  const names = Model.speciesNames(species);
  const ids = [];
  if (species.inatTaxonId) ids.push(species.inatTaxonId);

  for (const name of names) {
    try {
      const payload = await request(`api/inat/taxa?q=${encodeURIComponent(name)}`, 'GET');
      const want = name.toLowerCase();
      // Exact binomial only. A fuzzy match would silently plot a different
      // species' records under this one's name.
      const hit = (payload.results || []).find((t) => (t.scientificName || '').toLowerCase() === want);
      if (hit && !ids.includes(hit.id)) ids.push(hit.id);
    } catch {
      // A name that cannot be looked up is skipped; the others still count.
    }
  }
  state.inat.taxa.set(species.id, ids);
  return ids;
}

/**
 * Other people's records for the one species you are looking at.
 *
 * This used to be a blanket overlay of everything anyone had seen nearby,
 * which on a busy map is a few hundred dots of unrelated birds and weeds. It
 * only ever answered a question worth asking when it was narrowed to a single
 * species — so now that is the only way it fires.
 */
let inatTimer = null;
function loadInat() {
  clearTimeout(inatTimer);
  const species = selectedSpecies();
  if (!species || state.mode !== 'map' || state.config?.inaturalist?.enabled === false) {
    if (state.inat.results.length || state.inat.speciesId) {
      state.inat = { ...state.inat, results: [], problem: null, speciesId: null, loading: false };
    }
    return;
  }

  inatTimer = setTimeout(async () => {
    const box = state.inat.box || mapView?.bounds();
    if (!box) return;
    state.inat.loading = true;
    state.inat.speciesId = species.id;
    if (state.view === 'log') renderFilters(derive().rows);

    const taxa = await resolveTaxa(species);
    // A species iNaturalist does not recognise is not an error worth a banner.
    if (!taxa.length) {
      state.inat = { ...state.inat, results: [], loading: false,
        problem: `iNaturalist has no exact match for ${species.scientificName || 'this species'}.` };
      if (state.view === 'log') render();
      return;
    }

    const query = new URLSearchParams({
      swlat: box.swlat.toFixed(5), swlng: box.swlng.toFixed(5),
      nelat: box.nelat.toFixed(5), nelng: box.nelng.toFixed(5),
      // Several ids where the species goes by several names; iNaturalist
      // unions them.
      taxon_id: taxa.join(','),
    });
    try {
      const payload = await request(`api/inat/observations?${query}`, 'GET');
      // A slow reply for a species you have since moved off must not land.
      if (state.filters.speciesId !== species.id) return;
      state.inat.results = payload.results || [];
      state.inat.problem = payload.problem || null;
    } catch (err) {
      state.inat.results = [];
      state.inat.problem = err.message;
    } finally {
      state.inat.loading = false;
      if (state.view === 'log') render();
    }
  }, 400);
}

// --- the entry form ---------------------------------------------------------

// Sentinel value for the "create one now" option in a species picker. A real
// id can never collide with it: ids are alphanumeric.
const NEW_SPECIES = '__new';

/**
 * A species picker, grouped by kingdom. Rebuilt rather than patched on every
 * render — the list is short, and a stale option pointing at a deleted species
 * is a worse bug than a redundant redraw.
 */
function fillSpeciesSelect(node, selected, { allowNew = true } = {}) {
  const at = node.value;
  clear(node);
  node.append(new Option('— Unidentified —', ''));
  for (const type of Model.TYPES) {
    const members = state.species
      .filter((sp) => sp.kind === type.id)
      .sort((a, b) => (a.commonName || a.scientificName || '').localeCompare(b.commonName || b.scientificName || ''));
    if (!members.length) continue;
    const group = document.createElement('optgroup');
    group.label = type.label;
    for (const sp of members) {
      const label = sp.commonName || sp.scientificName || 'Unnamed';
      group.append(new Option(sp.scientificName && sp.commonName ? `${label} — ${sp.scientificName}` : label, sp.id));
    }
    node.append(group);
  }
  if (allowNew) node.append(new Option('+ New species…', NEW_SPECIES));
  node.value = selected ?? at ?? '';
  // A species that no longer exists leaves the select with no match, which
  // browsers render as blank. Fall back to unidentified explicitly.
  if (node.selectedIndex === -1) node.value = '';
}

/**
 * The only thing the entry form has to decide is whether it is safe to submit.
 *
 * Naming a find is a separate act, done later against the library — so the
 * form has no species picker and no confidence. What it captures is what you
 * cannot capture later: the photograph, and where and when you were standing.
 */
function syncObsForm() {
  const uploading = obsTray?.busy();
  $('obs-submit').disabled = !!uploading;
  $('obs-hint').textContent = uploading ? 'A photo is still uploading…' : '';
}

function resetObsForm() {
  obsTray?.clear();
  $('obs-type').value = state.config?.nature?.defaultType || 'fungi';
  for (const id of ['obs-when', 'obs-lat', 'obs-lon', 'obs-place', 'obs-notes']) $(id).value = '';
  $('obs-when-hint').textContent = ' ';
  syncObsForm();
}

/** A coordinate box that is empty, or holds something that is not a number. */
function readCoord(id, { min, max }) {
  const raw = $(id).value.trim();
  if (!raw) return { value: null, ok: true };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return { value: null, ok: false };
  return { value: n, ok: true };
}

async function submitObservation(ev) {
  ev.preventDefault();
  if (obsTray.busy()) { notice('A photo is still uploading.'); return; }

  const lat = readCoord('obs-lat', { min: -90, max: 90 });
  const lon = readCoord('obs-lon', { min: -180, max: 180 });
  if (!lat.ok || !lon.ok) {
    notice('Latitude must be between −90 and 90, longitude between −180 and 180.');
    return;
  }
  // Half a coordinate is not a location, and storing one would put the find on
  // the equator or the prime meridian.
  if ((lat.value === null) !== (lon.value === null)) {
    notice('A location needs both a latitude and a longitude.');
    return;
  }

  const observation = {
    id: uid(),
    version: 0,
    // Every find starts unidentified. That is the normal state of a thing you
    // have just picked up, and the log is more useful for admitting it.
    speciesId: null,
    // Type is stored even once a species is linked. It is what the find reads
    // as if that species is ever deleted, and re-deriving it then would be
    // impossible.
    type: $('obs-type').value,
    confidence: 'high',
    // What the specimen shows, filled in later from the identification sheet.
    characters: {},
    observedAt: $('obs-when').value || null,
    lat: lat.value,
    lon: lon.value,
    place: $('obs-place').value.trim() || null,
    notes: $('obs-notes').value.trim() || null,
    photos: obsTray.photos(),
    createdAt: new Date().toISOString(),
  };

  if (await saveRecord('observations', observation)) {
    resetObsForm();
    notice('');
    render();
  }
}

// --- the species view -------------------------------------------------------

function renderSpecies({ life }) {
  renderSpeciesFilters(life);
  renderSpeciesTable(life);
}

function renderSpeciesFilters(life) {
  const set = clear($('filter-sp-type'));
  set.append(choiceDropdown({
    name: 'filter-sp-type',
    label: 'Kind',
    current: state.speciesFilters.type,
    onPick: (id) => { state.speciesFilters.type = id; render(); },
    options: [
      { id: 'all', label: 'All kinds', count: life.length },
      // The badge comes along, so the colour that means "fungi" everywhere
      // else means it here too.
      ...Model.TYPES.map((t) => ({
        id: t.id,
        label: t.label,
        count: life.filter((sp) => sp.kind === t.id).length,
        mark: typeBadge(t.id),
        markIsLabel: true,
      })),
      // Not a kind, but the one cut across kinds worth having to hand.
      { id: 'choice', label: 'Choice edible', count: life.filter(Model.isChoice).length,
        mark: edibleBadge('choice'), markIsLabel: true },
    ],
  }));

  /*
   * A tag filter has no control of its own to sit in — it is arrived at from
   * the Glossary, or from a URL. So it announces itself as a chip that says
   * what is being filtered and offers the way out, rather than quietly
   * shortening the list with nothing to explain why.
   */
  if (state.speciesFilters.tag) {
    const term = state.speciesFilters.tag;
    const held = el('div', 'tag-filter');
    held.append(el('span', 'tag-filter-label', 'Tagged'));
    held.append(tagChip({ text: term, category: Model.classifyTag(term, null) }));
    const drop = el('button', 'tag-filter-clear', '×');
    drop.type = 'button';
    drop.title = `Stop filtering by “${term}”`;
    drop.setAttribute('aria-label', `Clear the ${term} filter`);
    drop.addEventListener('click', () => setSpeciesTag(''));
    held.append(drop);
    set.append(held);
  }
}

/** Filter the library to one term, or clear it. Recorded in the URL either way. */
function setSpeciesTag(term) {
  state.speciesFilters.tag = (term || '').trim();
  if (state.view !== 'species') {
    setView('species');
    return;
  }
  history.pushState(routeState(), '', routeUrl());
  render();
}

function renderSpeciesTable(life) {
  const q = state.speciesFilters.q.trim().toLowerCase();
  // Sorting on the id string would order these alphabetically — choice between
  // deadly and edible — which is exactly backwards for the column's purpose.
  const ranked = life.map((sp) => ({
    ...sp,
    edibleRank: Model.edibility(sp.edibility).rank,
    // What the row actually reads, so sorting the column sorts what is shown.
    // Sorting on commonName would pile every unnamed species under one blank.
    displayName: sp.commonName || sp.scientificName || '',
  }));
  const tag = state.speciesFilters.tag;
  const shown = ranked.filter((sp) => {
    if (state.speciesFilters.type === 'choice') { if (!Model.isChoice(sp)) return false; }
    else if (state.speciesFilters.type !== 'all' && sp.kind !== state.speciesFilters.type) return false;
    if (tag && !Model.speciesHasTag(sp, tag)) return false;
    if (!q) return true;
    return Model.speciesText(sp).includes(q);
  });

  const spec = state.speciesSort;
  const sign = spec.dir === 'desc' ? -1 : 1;
  const compare = (a, b, key) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av ?? '').localeCompare(String(bv ?? ''));
  };
  // Ties fall back to the common name so the order never shuffles between
  // renders — and the fallback is applied *after* the direction, or reversing
  // would flip the tie-break too.
  const sorted = [...shown].sort((a, b) => sign * compare(a, b, spec.key) || compare(a, b, 'displayName'));

  paintSortHeaders('species-head', spec);

  const body = clear($('species-rows'));
  if (!sorted.length) {
    const tr = el('tr');
    const td = el('td');
    td.colSpan = 7;
    td.append(el('div', 'empty-state', life.length ? 'No species match these filters.' : 'Nothing on file yet.'));
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const sp of sorted) {
    const tr = el('tr', 'is-clickable' + (sp.seen ? '' : ' is-muted'));
    tr.append(cell(speciesThumb(sp), 'nowrap'));
    /*
     * Both names in one cell, the way a find card shows them: the name you
     * would say out loud, and the binomial under it. Two columns cost 300px
     * of a 390px screen for what is one idea.
     *
     * A species with no common name leads with its binomial rather than the
     * word "Unnamed" above it — 109 of the fungi have none, and a column of
     * "Unnamed" is not a name column.
     */
    const names = el('div', 'sp-names');
    names.append(el('div', 'sp-name', sp.displayName));
    const under = sciLine(sp.displayName, sp.scientificName, 'sp-sci sci');
    if (under) names.append(under);
    tr.append(cell(names));
    tr.append(cell(typeBadge(sp.kind), 'nowrap sp-kind'));
    tr.append(cell(sp.edibility && sp.edibility !== 'unknown' ? edibleBadge(sp.edibility) : el('span', 'muted', '—'), 'nowrap sp-edible'));
    // Marked wide: dropped on a phone, where the four columns that
    // identify a species are worth more than the three that describe how
    // often you have met it.
    tr.append(cell(sp.habitat || el('span', 'muted', '—'), 'is-wide'));
    tr.append(cell(String(sp.count), 'r nowrap is-wide'));
    tr.append(cell(sp.last ? fmtDate(sp.last) : el('span', 'muted', 'never'), 'nowrap is-wide'));
    tr.addEventListener('click', () => openSpeciesSheet(sp.id));
    body.append(tr);
  }
}

function cell(content, cls) {
  const td = el('td', cls);
  td.append(typeof content === 'string' ? document.createTextNode(content) : content);
  return td;
}

function speciesThumb(sp) {
  const src = thumbSrc(coverOf(sp));
  if (!src) {
    const box = el('div', 'row-thumb is-empty', Model.typeGlyph(sp.kind));
    return box;
  }
  const img = el('img', 'row-thumb');
  img.src = src;
  img.alt = '';
  img.loading = 'lazy';
  return img;
}

/** Marks the active column and points the arrow, for sighted and AT users alike. */
function paintSortHeaders(headId, spec) {
  for (const th of document.querySelectorAll(`#${headId} th[data-sort]`)) {
    let arrow = th.querySelector('.sort-arrow');
    if (!arrow) {
      arrow = el('span', 'sort-arrow');
      th.append(arrow);
    }
    if (th.dataset.col === spec.col) {
      th.setAttribute('aria-sort', spec.dir === 'asc' ? 'ascending' : 'descending');
      arrow.textContent = spec.dir === 'asc' ? '▲' : '▼';
    } else {
      th.removeAttribute('aria-sort');
      arrow.textContent = '';
    }
  }
}

function wireSortHeaders(headId, spec, onChange) {
  for (const th of document.querySelectorAll(`#${headId} th[data-sort]`)) {
    const activate = () => {
      const key = th.dataset.sort;
      const col = th.dataset.col;
      if (spec.col === col) {
        spec.dir = spec.dir === 'asc' ? 'desc' : 'asc';
      } else {
        spec.col = col;
        spec.key = key;
        // Names read best A-Z; counts and dates read best largest-first.
        spec.dir = key === 'count' || key === 'last' ? 'desc' : 'asc';
      }
      onChange();
    };
    th.addEventListener('click', activate);
    th.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(); }
    });
    th.tabIndex = 0;
  }
}

// --- tag suggestions --------------------------------------------------------

/*
 * How often each term is used, per character and overall.
 *
 * Cached because it walks the whole library — 400-odd species times nine
 * characters — and a sheet builds nine tag fields at once. Invalidated
 * whenever a record is written, which is the only thing that can change it.
 */
let usageCache = null;
const invalidateUsage = () => { usageCache = null; };

function tagUsage() {
  if (usageCache) return usageCache;
  const perCharacter = new Map();
  const overall = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const record of [...state.species, ...state.observations]) {
    for (const spec of Model.FUNGI_CHARACTERS) {
      for (const tag of Model.character(record, spec.id).tags) {
        const term = Model.normalizeTag(tag.text);
        bump(perCharacter, `${spec.id}\t${term}`);
        bump(overall, term);
      }
    }
  }
  usageCache = { perCharacter, overall };
  return usageCache;
}

// How many of each category the popover offers before filtering. Enough to be
// a menu, few enough to read without scrolling.
const SUGGESTIONS_PER_CATEGORY = 5;

/**
 * Terms worth offering under one character, grouped by category.
 *
 * Ranked by how often the term is used on *this* character first, then
 * anywhere, then alphabetically. What people actually write under Gills is a
 * better suggestion than what a vocabulary list happens to contain, and
 * `decurrent` should never be the first thing offered under Cap.
 */
function tagSuggestions(spec, query, taken) {
  const { perCharacter, overall } = tagUsage();
  const q = Model.normalizeTag(query);
  const held = new Set(taken.map((t) => Model.normalizeTag(t.text)));

  const pool = new Set([
    ...Model.characterVocab(spec),
    ...[...overall.keys()],
  ]);

  const groups = new Map(Model.TAG_CATEGORIES.map((c) => [c.id, []]));
  for (const term of pool) {
    const key = Model.normalizeTag(term);
    if (held.has(key)) continue;
    if (q && !key.includes(q)) continue;
    // Measurements are values; there is nothing to suggest.
    const category = Model.classifyTag(term, spec);
    if (category === 'measure') continue;
    groups.get(category)?.push({
      text: term,
      category,
      here: perCharacter.get(`${spec.id}\t${key}`) || 0,
      anywhere: overall.get(key) || 0,
    });
  }

  const out = [];
  for (const cat of Model.TAG_CATEGORIES) {
    const list = groups.get(cat.id) || [];
    if (!list.length) continue;
    list.sort((a, b) => b.here - a.here || b.anywhere - a.anywhere || a.text.localeCompare(b.text));
    out.push({ category: cat, terms: list.slice(0, SUGGESTIONS_PER_CATEGORY), total: list.length });
  }
  return out;
}

// --- photo trays ------------------------------------------------------------

/**
 * A dropzone with a strip of photos under it, used by the entry form and by
 * both sheet editors. It owns the in-flight state of an upload so its callers
 * never have to: `photos()` returns only what is actually stored, and `busy()`
 * says whether saving now would drop something still on the wire.
 *
 * The entry form passes in the nodes already present in the markup; the sheets
 * let it build its own.
 */
function makeTray({ zone, fileInput, strip, existing, onChange, note, addBelow = false } = {}) {
  const owned = !zone;
  if (owned) {
    zone = el('div', 'dropzone');
    zone.tabIndex = 0;
    zone.setAttribute('role', 'button');
    zone.append(el('span', 'dropzone-title', 'Add photos'), el('span', 'dropzone-note', note || 'Drop them here, or click to choose.'));
    fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.hidden = true;
    strip = el('div', 'shot-strip');
  }

  const shots = (existing || []).map((p) => ({ key: uid(), name: p.name, status: 'ready', photo: p, error: null }));

  const draw = () => {
    clear(strip);
    for (const shot of shots) {
      strip.append(shotCard(shot, () => {
        shots.splice(shots.indexOf(shot), 1);
        draw();
        onChange?.();
      }, () => {
        // Every ready photograph in this tray, so the viewer can be paged
        // through from whichever one was clicked.
        const ready = shots.filter((x) => x.photo).map((x) => x.photo);
        openLightbox(ready, ready.indexOf(shot.photo));
      }));
    }
  };

  wireDropzone(zone, fileInput, (files) => {
    for (const file of Array.from(files || [])) {
      const shot = { key: uid(), name: file.name, status: 'working', photo: null, error: null };
      shots.push(shot);
      draw();
      onChange?.();
      ingestPhoto(file)
        .then((photo) => { shot.photo = photo; shot.status = 'ready'; })
        .catch((err) => {
          shot.status = 'failed';
          shot.error = err.message;
          notice(`Could not add ${file.name}: ${err.message}`);
        })
        .finally(() => { draw(); onChange?.(); });
    }
    onChange?.();
  });

  draw();

  const node = owned ? el('div') : null;
  // On a species the photographs are the point of the section and the
  // dropzone is a footnote, so the reference shots come first and "Add
  // photos" sits under them.
  if (node) node.append(...(addBelow ? [strip, fileInput, zone] : [zone, fileInput, strip]));

  return {
    node,
    photos: () => shots.filter((s) => s.photo).map((s) => s.photo),
    busy: () => shots.some((s) => s.status === 'working'),
    clear: () => { shots.length = 0; draw(); },
  };
}

// --- the sheet --------------------------------------------------------------

/**
 * Open the detail overlay. `build` fills it and may register a dirty flag; the
 * flag is what makes an accidental Escape ask before throwing away an edit.
 */
function openSheet(build) {
  const scrim = $('scrim');
  const sheet = clear($('sheet'));
  const returnFocus = document.activeElement;
  state.sheetDirty = false;

  const close = ({ force = false } = {}) => {
    if (!force && state.sheetDirty && !confirm('Discard unsaved changes?')) return;
    scrim.hidden = true;
    state.closeSheet = null;
    state.sheetDirty = false;
    clear(sheet);
    document.body.style.overflow = '';
    returnFocus?.focus?.();
  };
  state.closeSheet = close;

  build(sheet, close);
  scrim.hidden = false;
  // The page behind must not scroll while the overlay is up, or a flick on a
  // phone moves the gallery instead of the sheet.
  document.body.style.overflow = 'hidden';
  sheet.querySelector('select, input, textarea, button')?.focus();
}

const markDirty = () => { state.sheetDirty = true; };

/** Every editable control in a sheet reports its own edits through this. */
function watchEdits(root) {
  root.addEventListener('input', markDirty);
  root.addEventListener('change', markDirty);
}

function sheetHead(sheet, titleText, subText, close, { unknown } = {}) {
  const head = el('div', 'sheet-head');
  const left = el('div');
  const title = el('h2', 'sheet-title' + (unknown ? ' is-unknown' : ''), titleText);
  title.id = 'sheet-title';
  left.append(title);
  const sub = el('p', 'sheet-sub sci', subText && subText.trim() !== (titleText || '').trim().replace(/\?$/, '') ? subText : '');
  left.append(sub);
  head.append(left);

  const closeButton = el('button', 'sheet-close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.addEventListener('click', () => close());
  head.append(closeButton);
  sheet.append(head);
  return { title, sub };
}

function sheetSection(sheet, eyebrow, note) {
  const section = el('section', 'sheet-section');
  if (eyebrow) {
    const head = el('div', 'block-head');
    head.append(el('h3', 'eyebrow', eyebrow));
    if (note) head.append(el('p', 'block-note', note));
    section.append(head);
  }
  sheet.append(section);
  return section;
}

/**
 * A photograph at the size of the screen.
 *
 * Reference shots are for looking at closely — whether the false gills really
 * are ridges is not a question a 90-pixel thumbnail can answer. These used to
 * link out to iNaturalist, which answered a different question (who took it)
 * at the cost of leaving the app mid-identification.
 *
 * Built once and reused: opening it twice should not stack two overlays.
 */
let lightbox = null;

function openLightbox(photos, startAt = 0) {
  const list = (photos || []).filter((p) => fullSrc(p) || thumbSrc(p));
  if (!list.length) return;
  let at = Math.max(0, Math.min(startAt, list.length - 1));

  if (!lightbox) {
    const node = el('div', 'lightbox');
    node.hidden = true;
    const img = el('img', 'lightbox-img');
    const caption = el('div', 'lightbox-caption');
    const credit = el('a', 'lightbox-credit');
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    const counter = el('span', 'lightbox-count');
    caption.append(credit, counter);

    const close = el('button', 'lightbox-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    const prev = el('button', 'lightbox-step is-prev', '\u2039');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous photograph');
    const next = el('button', 'lightbox-step is-next', '\u203a');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next photograph');

    node.append(img, caption, close, prev, next);
    document.body.append(node);
    lightbox = { node, img, credit, counter, close, prev, next, list: [], at: 0 };

    const hide = () => {
      lightbox.node.hidden = true;
      document.removeEventListener('keydown', onKey);
      // Release the image so a large photograph is not held in memory behind
      // a hidden overlay.
      lightbox.img.removeAttribute('src');
    };
    const step = (by) => {
      if (lightbox.list.length < 2) return;
      lightbox.at = (lightbox.at + by + lightbox.list.length) % lightbox.list.length;
      paint();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); hide(); }
      else if (ev.key === 'ArrowRight') step(1);
      else if (ev.key === 'ArrowLeft') step(-1);
    };
    lightbox.hide = hide;
    lightbox.step = step;
    lightbox.onKey = onKey;

    close.addEventListener('click', hide);
    prev.addEventListener('click', (ev) => { ev.stopPropagation(); step(-1); });
    next.addEventListener('click', (ev) => { ev.stopPropagation(); step(1); });
    // Clicking the backdrop closes; clicking the photograph itself does not,
    // so a mis-aimed click while looking does not throw the view away.
    node.addEventListener('click', (ev) => { if (ev.target === node) hide(); });
  }

  function paint() {
    const photo = lightbox.list[lightbox.at];
    lightbox.img.src = fullSrc(photo) || thumbSrc(photo);
    lightbox.img.alt = photo.attribution || '';
    const text = photo.attribution || photo.name || '';
    lightbox.credit.textContent = text;
    if (photo.sourceUrl) {
      lightbox.credit.href = photo.sourceUrl;
      lightbox.credit.classList.remove('is-plain');
    } else {
      lightbox.credit.removeAttribute('href');
      lightbox.credit.classList.add('is-plain');
    }
    const many = lightbox.list.length > 1;
    lightbox.counter.textContent = many ? `${lightbox.at + 1} of ${lightbox.list.length}` : '';
    lightbox.prev.hidden = !many;
    lightbox.next.hidden = !many;
  }

  lightbox.list = list;
  lightbox.at = at;
  paint();
  lightbox.node.hidden = false;
  document.addEventListener('keydown', lightbox.onKey);
  lightbox.close.focus();
}

/** A hero image with a thumbnail rail under it, when there is more than one. */
function photoViewer(photos, onSelect) {
  const wrap = el('div');
  const hero = el('div', 'sheet-hero');
  wrap.append(hero);

  const show = (index) => {
    clear(hero);
    const p = photos[index];
    const src = fullSrc(p);
    if (src) {
      const img = el('img');
      img.src = src;
      img.alt = p.name || 'Photograph';
      hero.append(img);
    } else {
      hero.append(el('span', 'no-preview', '🖼'));
    }
    for (const [i, button] of rail.entries()) button.classList.toggle('is-on', i === index);
    onSelect?.(p);
  };

  const rail = [];
  if (photos.length > 1) {
    const thumbs = el('div', 'sheet-thumbs');
    photos.forEach((p, i) => {
      const button = el('button', 'sheet-thumb');
      button.type = 'button';
      button.setAttribute('aria-label', `Photo ${i + 1}`);
      const src = thumbSrc(p);
      if (src) {
        const img = el('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        button.append(img);
      } else {
        button.append(el('span', 'no-preview', '🖼'));
      }
      button.addEventListener('click', () => show(i));
      rail.push(button);
      thumbs.append(button);
    });
    wrap.append(thumbs);
  }

  if (photos.length) show(0);
  else hero.append(el('span', 'no-preview', '🖼'));
  return wrap;
}

/** What the camera recorded, as opposed to what the log says. */
function photoFacts(photo) {
  const list = el('dl', 'facts');
  const add = (term, value, { mono } = {}) => {
    if (value == null || value === '') return;
    const wrap = el('div');
    wrap.append(el('dt', null, term));
    const dd = el('dd', mono ? 'mono' : null);
    dd.append(typeof value === 'string' ? document.createTextNode(value) : value);
    wrap.append(dd);
    list.append(wrap);
  };

  if (!photo) {
    list.append(el('p', 'muted', 'No photographs on this record.'));
    return list;
  }
  add('File', photo.name, { mono: true });
  add('Size', [photo.bytes ? fmtBytes(photo.bytes) : null, photo.width && photo.height ? `${photo.width}×${photo.height}` : null].filter(Boolean).join(' · '), { mono: true });
  add('Camera', [photo.make, photo.model].filter(Boolean).join(' ') || null);
  add('Shutter time', photo.takenAt ? fmtWhen(photo.takenAt) + (photo.offset ? ` (UTC${photo.offset})` : '') : (photo.hasExif ? 'not recorded' : 'no EXIF'), { mono: true });

  const link = Model.mapLink(photo.lat, photo.lon);
  if (link) {
    const anchor = el('a', null, Model.formatCoord(photo.lat, photo.lon));
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    add('Camera position', anchor, { mono: true });
  } else {
    add('Camera position', photo.hasExif ? 'not recorded' : 'no EXIF');
  }
  add('Altitude', Number.isFinite(photo.altitude) ? `${photo.altitude} m` : null, { mono: true });
  return list;
}

// --- the observation sheet --------------------------------------------------

function openObservationSheet(id) {
  const stored = state.observations.find((o) => o.id === id);
  if (!stored) return;
  openSheet((sheet, close) => buildObservationSheet(sheet, stored, close));
}

function buildObservationSheet(sheet, stored, close) {
  const index = Model.byId(state.species);
  const row = Model.view(stored, index);

  const head = sheetHead(sheet, row.name, row.scientificName, close, { unknown: !row.identified });

  // --- photographs
  const shown = sheetSection(sheet);
  const factsHolder = el('div');
  shown.append(photoViewer(row.photos || [], (photo) => {
    clear(factsHolder).append(photoFacts(photo));
  }));
  if (!(row.photos || []).length) clear(factsHolder).append(photoFacts(null));

  // --- the record
  const editor = sheetSection(sheet, 'The record');
  const form = el('form');
  watchEdits(form);
  editor.append(form);

  // Carried from the species, not stored on the find: edibility is a fact
  // about the organism, and it must not go stale on a copy.
  const edibleLine = el('div');
  edibleLine.style.marginBottom = '10px';
  const paintEdible = (species) => {
    clear(edibleLine);
    if (!species || !species.edibility || species.edibility === 'unknown') return;
    edibleLine.append(edibleBadge(species.edibility));
    if (species.lookalikes) {
      edibleLine.append(el('span', 'field-hint', ` Lookalikes: ${species.lookalikes}`));
    }
  };
  editor.insertBefore(edibleLine, form);

  const speciesPick = el('select');
  fillSpeciesSelect(speciesPick, stored.speciesId || '');
  const typePick = select(Model.TYPES, row.type);
  const confidencePick = select([{ id: 'high', label: 'High' }, { id: 'low', label: 'Low — flag with ?' }], stored.confidence || 'high');
  const whenPick = input('datetime-local', stored.observedAt || '');
  const latPick = input('text', stored.lat ?? '', { class: 'coord', inputmode: 'decimal', placeholder: '—' });
  const lonPick = input('text', stored.lon ?? '', { class: 'coord', inputmode: 'decimal', placeholder: '—' });
  const placePick = input('text', stored.place || '', { placeholder: 'Trailside, mixed conifer' });
  const notesPick = el('textarea');
  notesPick.value = stored.notes || '';

  // Assigned once the traits section is built, below; sync() runs after that.
  let paintTraits = () => {};

  /** The title is derived, so it has to follow the controls, not the file. */
  const sync = () => {
    const chosen = speciesPick.value && speciesPick.value !== NEW_SPECIES
      ? state.species.find((s) => s.id === speciesPick.value)
      : null;
    typePick.disabled = !!chosen;
    if (chosen) typePick.value = chosen.kind;
    confidencePick.disabled = !chosen;

    paintEdible(chosen);
    paintTraits(chosen);
    const preview = Model.displayName({ confidence: confidencePick.value }, chosen);
    head.title.textContent = preview;
    head.title.classList.toggle('is-unknown', !chosen);
    head.sub.textContent = chosen?.scientificName || '';
  };

  speciesPick.addEventListener('change', () => {
    if (speciesPick.value === NEW_SPECIES) {
      // Creating a species from inside a find: build it, then come back with
      // it selected. Cancelling has to put the old choice back, or the picker
      // is left sitting on a sentinel.
      const previous = stored.speciesId || '';
      openSpeciesSheet(null, {
        kind: typePick.value,
        onCreated: (created) => {
          openSheet((s2, c2) => buildObservationSheet(s2, { ...stored, speciesId: created ? created.id : previous }, c2));
        },
      });
      return;
    }
    sync();
  });
  confidencePick.addEventListener('change', sync);

  const rowA = el('div', 'entry-row');
  rowA.append(
    field('Species', speciesPick, { grow: true }),
    field('Type', typePick, {}),
    field('Confidence', confidencePick, {}),
    field('When', whenPick, {}),
  );

  const rowB = el('div', 'entry-row');
  rowB.append(
    field('Latitude', latPick, {}),
    field('Longitude', lonPick, {}),
    field('Place', placePick, { grow: true }),
    field('Notes', notesPick, { wide: true }),
  );
  form.append(rowA, rowB);

  // What you wrote down about this specimen, as against what the species is
  // supposed to be. Keeping the two apart is the point: one is an observation,
  // the other is a reference, and conflating them loses the evidence.
  const seenTraits = Model.FUNGI_CHARACTERS
    .map((spec) => ({ spec, c: Model.character(stored, spec.id) }))
    .filter((x) => x.c.tags.length);
  if (seenTraits.length) {
    const seenSection = sheetSection(sheet, 'What you saw', 'Tagged on this find, from the identification sheet.');
    const list = el('dl', 'facts');
    for (const { spec, c } of seenTraits) {
      const wrap = el('div');
      wrap.append(el('dt', null, spec.label));
      const dd = el('dd');
      const chips = el('div', 'tag-list is-static');
      for (const tag of c.tags) chips.append(tagChip(tag));
      dd.append(chips);
      wrap.append(dd);
      list.append(wrap);
    }
    seenSection.append(list);
  }

  // What the species record says about the organism. This is the comparison
  // you actually make when confirming an identification, and it reads from the
  // species so it can never go stale.
  const traitsSection = sheetSection(sheet, 'The species', 'Recorded on the species, not on this find.');
  const traitsHolder = el('div');
  traitsSection.append(traitsHolder);

  paintTraits = (species) => {
    clear(traitsHolder);
    const traits = Model.fungiTraits(species);
    traitsSection.hidden = !traits.length;
    if (!traits.length) return;
    const list = el('dl', 'facts');
    for (const trait of traits) {
      const wrap = el('div');
      wrap.append(el('dt', null, trait.label));
      const dd = el('dd', trait.absent ? 'is-absent' : null);
      if (trait.tags.length) {
        // The same chips as the editor, minus the controls: this is a reading
        // surface, and the species is edited on its own sheet.
        const chips = el('div', 'tag-list is-static');
        for (const tag of trait.tags) chips.append(tagChip(tag));
        dd.append(chips);
      } else {
        dd.append(document.createTextNode(trait.value));
      }
      wrap.append(dd);
      list.append(wrap);
    }
    traitsHolder.append(list);
  };

  sync();

  // --- photographs, editable
  const tray = makeTray({ existing: row.photos || [], onChange: markDirty, note: 'Another angle, the underside, the spore print.' });
  const photoEdit = sheetSection(sheet, 'Photographs', 'The first one is the cover.');
  photoEdit.append(tray.node);

  // --- what the camera said
  const factsSection = sheetSection(sheet, 'From the file', 'Read out of the photograph, and never overwritten by the fields above.');
  factsSection.append(factsHolder);

  // --- actions
  const actions = el('div', 'form-actions');
  const remove = el('button', 'ghost-button is-danger', 'Delete');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    if (!confirm('Delete this find? Its photographs go with it.')) return;
    if (await deleteRecord('observations', stored.id)) {
      close({ force: true });
      render();
    }
  });

  const save = el('button', 'solid-button', 'Save');
  save.type = 'button';
  save.addEventListener('click', async () => {
    if (tray.busy()) { notice('A photo is still uploading.'); return; }

    const lat = coordValue(latPick.value, 90);
    const lon = coordValue(lonPick.value, 180);
    if (lat === false || lon === false) {
      notice('Latitude must be between −90 and 90, longitude between −180 and 180.');
      return;
    }
    if ((lat === null) !== (lon === null)) {
      notice('A location needs both a latitude and a longitude.');
      return;
    }

    const chosen = speciesPick.value && speciesPick.value !== NEW_SPECIES
      ? state.species.find((s) => s.id === speciesPick.value)
      : null;

    const next = {
      ...stored,
      speciesId: chosen ? chosen.id : null,
      type: chosen ? chosen.kind : typePick.value,
      confidence: chosen ? confidencePick.value : 'high',
      observedAt: whenPick.value || null,
      lat, lon,
      place: placePick.value.trim() || null,
      notes: notesPick.value.trim() || null,
      photos: tray.photos(),
    };
    if (await saveRecord('observations', next)) {
      // A find whose location or species changed moves or recolours its pin.
      close({ force: true });
      render();
    }
  });

  const identify = el('button', 'ghost-button', row.identified ? 'Re-identify' : 'Identify');
  identify.type = 'button';
  identify.addEventListener('click', () => { close({ force: true }); openIdentifySheet(stored.id); });
  actions.append(identify);

  actions.append(el('span', 'save-status spacer', `Logged ${fmtDate((stored.createdAt || '').slice(0, 10)) || '—'}`), remove, save);
  sheet.append(actions);
}

/** null for blank, false for unusable, a number otherwise. */
function coordValue(raw, limit) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : false;
}

// --- the identification sheet -----------------------------------------------

function openIdentifySheet(id) {
  const stored = state.observations.find((o) => o.id === id);
  if (!stored) return;
  openSheet((sheet, close) => buildIdentifySheet(sheet, stored, close));
}

/**
 * Putting a name to a find.
 *
 * The order is the order the work actually happens in: look at the specimen,
 * write down what it shows, and let the library narrow itself. Picking the
 * species is the last step rather than the first, which is why this is a
 * separate sheet from the record — the entry form does not ask for a name it
 * has no way of knowing yet.
 */
function buildIdentifySheet(sheet, stored, close) {
  const index = Model.byId(state.species);
  const row = Model.view(stored, index);

  // A working copy. Nothing is written until Save or Identify is pressed, so
  // backing out of a half-finished key leaves the find as it was.
  const draftObs = {
    type: stored.type,
    characters: JSON.parse(JSON.stringify(stored.characters || {})),
  };

  let chosen = null;
  let confidence = stored.confidence === 'low' ? 'low' : 'high';

  const head = sheetHead(sheet, row.name, row.scientificName, close, { unknown: !row.identified });

  // --- the specimen
  const shots = sheetSection(sheet);
  shots.append(photoViewer(row.photos || [], null));
  const known = [fmtWhen(row.when), row.place, row.hasPlace ? Model.formatCoord(row.lat, row.lon) : null]
    .filter(Boolean).join(' · ');
  if (known) shots.append(el('p', 'sheet-sub', known));
  if (row.notes) shots.append(el('p', 'identify-notes', row.notes));

  // --- what you can see
  const canTag = stored.type === 'fungi';
  let fields = [];
  if (canTag) {
    const charSection = sheetSection(sheet, 'What you can see',
      'Tag the specimen in front of you. Every tag narrows the list below.');
    const grid = el('div', 'characters');
    fields = Model.FUNGI_CHARACTERS.map((spec) => {
      const f = tagField(spec, Model.character(draftObs, spec.id), () => { collect(); redraw(); });
      grid.append(f.node);
      return f;
    });
    charSection.append(grid);
  }

  // --- the candidates
  const candSection = sheetSection(sheet, 'Possible species');
  const candNote = el('p', 'block-note');
  candSection.querySelector('.block-head').append(candNote);
  // The list scrolls inside its own box rather than pushing the decision off
  // the bottom of the sheet. Four hundred candidates is a lot of thumb.
  const candScroll = el('div', 'candidates-scroll');
  const candList = el('div', 'candidates');
  candScroll.append(candList);
  candSection.append(candScroll);
  const candFoot = el('div', 'candidates-foot');
  candSection.append(candFoot);
  let showRuledOut = false;

  /*
   * What you picked, in enough detail to second-guess it.
   *
   * Choosing from a scrolling list of forty names is not the decision — the
   * decision is whether this specimen is that species, and that needs the
   * reference photographs and the recorded characters side by side with the
   * tags you just wrote. Sitting between the list and the Identify button, it
   * is the last thing read before committing a name.
   */
  const pickSection = sheetSection(sheet, 'Chosen');
  const pickBody = el('div', 'chosen-panel');
  pickSection.append(pickBody);

  // --- the decision
  const footer = el('div', 'identify-footer');
  const footerText = el('div', 'identify-choice');
  const confidencePick = select([{ id: 'high', label: 'Confident' }, { id: 'low', label: 'Uncertain — flag with ?' }], confidence);
  confidencePick.addEventListener('change', () => { confidence = confidencePick.value; paintFooter(); });
  const confidenceWrap = field('Confidence', confidencePick, {});

  const assign = el('button', 'solid-button', 'Identify');
  assign.type = 'button';
  assign.addEventListener('click', () => commit({ speciesId: chosen.id, confidence }));

  const saveTags = el('button', 'ghost-button', 'Save tags only');
  saveTags.type = 'button';
  saveTags.title = 'Keep what you have written down and leave it unidentified.';
  saveTags.addEventListener('click', () => commit({}));

  // Deleting a find is available whether or not it has a name. A photo of
  // something you have since decided was a leaf is still worth throwing away,
  // and until now the only route to Delete was through identifying it first.
  const remove = el('button', 'ghost-button is-danger', 'Delete');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    if (!confirm('Delete this find? Its photographs go with it.')) return;
    if (await deleteRecord('observations', stored.id)) {
      close({ force: true });
      render();
    }
  });

  const left = el('div', 'identify-actions-left');
  left.append(remove);

  footer.append(footerText, left, confidenceWrap, saveTags, assign);
  sheet.append(footer);

  // --- behaviour

  function collect() {
    draftObs.characters = canTag ? readCharacters(fields) : {};
    markDirty();
  }

  function redraw() {
    const { rows, anyTags, pool } = Model.rankCandidates(draftObs, state.species);
    const tagCount = Model.observedTagCount(draftObs);

    const kept = rows.filter((m) => !m.contradicted).length;
    candNote.textContent = !pool
      ? `Nothing in the library is ${Model.typeLabel(draftObs.type).toLowerCase()} yet.`
      : anyTags
        ? `${plural(kept, 'species')} still possible, ranked against ${plural(tagCount, 'tag')}.`
        : `${plural(pool, 'species')} on file. Add tags above to narrow this down.`;

    // Ruled-out species are hidden, not dropped. A contradiction is usually
    // right, but it can also mean the specimen was misread or the library is
    // wrong, so they stay one click away rather than vanishing.
    const ruledOut = rows.filter((m) => m.contradicted);
    const candidates = showRuledOut ? rows : rows.filter((m) => !m.contradicted);

    clear(candList);
    for (const match of candidates) candList.append(candidateRow(match));
    if (!candidates.length) {
      candList.append(el('div', 'empty-state',
        rows.length ? 'Every species is ruled out by these tags.' : 'No species of this type on file yet.'));
    }
    // Scrolled back to the top: after a new tag the best match is the first
    // row, and leaving the box where it was hides it.
    candScroll.scrollTop = 0;

    clear(candFoot);
    if (ruledOut.length) {
      const dangerous = ruledOut.filter((m) => Model.isDangerous(m.species)).length;
      const toggle = el('button', 'ghost-button' + (dangerous ? ' is-danger' : ''));
      toggle.type = 'button';
      // "ruled out" is a phrase, not a countable noun — plural() would make it
      // "386 ruled outs".
      const count = `${ruledOut.length} ruled out`;
      toggle.textContent = showRuledOut
        ? `Hide the ${count}`
        : dangerous
          // Naming the dangerous ones is the point of not simply dropping them.
          ? `Show ${count} — ${dangerous} toxic or worse`
          : `Show ${count}`;
      toggle.addEventListener('click', () => { showRuledOut = !showRuledOut; redraw(); });
      candFoot.append(toggle);
    }
    candFoot.append(writeUpButton());
    paintChosen(rows);
    paintFooter();
  }

  function candidateRow(match) {
    const sp = match.species;
    const card = el('button', 'candidate');
    card.type = 'button';
    if (match.contradicted) card.classList.add('is-contradicted');
    // Ruled out AND dangerous is the combination that must never be dimmed
    // into the background. Tagging "morel" rules out the false morels — which
    // is exactly the moment someone who has confused the two needs to see
    // them, and read why they were ruled out.
    if (Model.isDangerous(sp)) card.classList.add('is-dangerous');
    if (chosen && chosen.id === sp.id) card.classList.add('is-chosen');

    const shot = el('div', 'candidate-shot');
    const src = thumbSrc(coverOf(sp));
    if (src) {
      const img = el('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      shot.append(img);
    } else {
      shot.append(el('span', 'no-preview', Model.typeGlyph(sp.kind)));
    }
    card.append(shot);

    const body = el('div', 'candidate-body');
    const line = el('div', 'candidate-name-row');
    line.append(el('h4', 'candidate-name', sp.commonName || sp.scientificName || 'Unnamed'));
    if (sp.edibility && sp.edibility !== 'unknown') line.append(edibleBadge(sp.edibility));
    body.append(line);
    const sci = sciLine(sp.commonName || sp.scientificName, sp.scientificName, 'candidate-sci sci');
    if (sci) body.append(sci);

    if (match.matched.length) {
      const chips = el('div', 'tag-list is-static');
      for (const hit of match.matched) chips.append(tagChip(hit.tag));
      body.append(chips);
    }
    for (const clash of match.conflicts) {
      body.append(el('p', 'candidate-conflict', `You tagged “${clash.tag.text}” under ${clash.character.label} — this species is recorded as: ${clash.reason}.`));
    }
    card.append(body);

    const score = el('div', 'candidate-score');
    if (match.contradicted) score.append(el('span', 'candidate-ruled', 'Ruled out'));
    else if (match.matched.length) score.append(el('span', 'candidate-hits', String(match.matched.length)), el('span', 'candidate-hits-label', 'matched'));
    else score.append(el('span', 'candidate-hits-label', match.compared ? 'no match' : 'not compared'));
    card.append(score);

    card.addEventListener('click', () => {
      chosen = chosen && chosen.id === sp.id ? null : sp;
      redraw();
    });
    return card;
  }

  /**
   * The chosen species, laid out to be argued with.
   *
   * `match` is the same ranking row the list used, so the tags it agreed with
   * are marked as agreeing rather than merely listed again — the question
   * being answered is "does this fit", not "what is this".
   */
  function paintChosen(rows) {
    clear(pickBody);
    pickSection.hidden = !chosen;
    if (!chosen) return;
    const sp = chosen;
    const match = (rows || []).find((m) => m.species.id === sp.id);

    // Reference photographs: what a good one looks like, which is the whole
    // reason they were worth importing.
    const shots = el('div', 'chosen-shots');
    const photos = (sp.photos || []).slice(0, 3);
    if (photos.length) {
      for (const [i, photo] of photos.entries()) {
        const src = thumbSrc(photo) || fullSrc(photo);
        if (!src) continue;
        const frame = el('button', 'chosen-shot');
        frame.type = 'button';
        const img = el('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        frame.append(img);
        // The credit still lives on hover; the click is for looking closely.
        if (photo.attribution) frame.title = photo.attribution;
        frame.addEventListener('click', () => openLightbox(photos, i));
        shots.append(frame);
      }
    } else {
      shots.append(el('div', 'chosen-noshot', 'No reference photographs on file.'));
    }

    const facts = el('div', 'chosen-facts');
    const head = el('div', 'chosen-head');
    head.append(el('h4', 'chosen-name', sp.commonName || sp.scientificName || 'Unnamed'));
    if (sp.edibility && sp.edibility !== 'unknown') head.append(edibleBadge(sp.edibility));
    facts.append(head);
    const sci = sciLine(sp.commonName || sp.scientificName, sp.scientificName, 'chosen-sci sci');
    if (sci) facts.append(sci);

    // The one line that can stop a hand: what this gets confused with.
    if (sp.lookalikes) {
      facts.append(el('p', 'chosen-lookalikes', `Confused with: ${sp.lookalikes}`));
    }
    if (sp.habitat) facts.append(el('p', 'chosen-habitat', sp.habitat));

    if (match && match.conflicts.length) {
      for (const clash of match.conflicts) {
        facts.append(el('p', 'candidate-conflict',
          `You tagged \u201c${clash.tag.text}\u201d under ${clash.character.label} — this species is recorded as: ${clash.reason}.`));
      }
    }
    pickBody.append(shots, facts);

    // The recorded characters, with the ones your tags agreed on marked. The
    // rest are what to go and look at again before committing.
    const agreed = new Set((match?.matched || []).map((h) => `${h.character.id}:${Model.termGroup(h.tag.text)}`));
    const traits = Model.fungiTraits(sp);
    if (traits.length) {
      const list = el('dl', 'facts chosen-traits');
      for (const trait of traits) {
        const wrap = el('div');
        wrap.append(el('dt', null, trait.label));
        const dd = el('dd', trait.absent ? 'is-absent' : null);
        if (trait.tags.length) {
          const chips = el('div', 'tag-list is-static');
          for (const tag of trait.tags) {
            const chip = tagChip(tag);
            if (agreed.has(`${trait.id}:${Model.termGroup(tag.text)}`)) chip.classList.add('is-agreed');
            chips.append(chip);
          }
          dd.append(chips);
        } else {
          dd.append(document.createTextNode(trait.value));
        }
        wrap.append(dd);
        list.append(wrap);
      }
      pickBody.append(list);
    }
  }

  /** Nothing in the library fits — write the species up from these very tags. */
  function writeUpButton() {
    const wrap = el('span', 'candidate-writeup');
    const button = el('button', 'ghost-button', 'None of these — write it up');
    button.type = 'button';
    button.addEventListener('click', () => {
      openSpeciesSheet(null, {
        kind: draftObs.type,
        // The characters carry across, so a new species arrives already
        // describing the specimen that prompted it.
        seed: { characters: JSON.parse(JSON.stringify(draftObs.characters)) },
        onCreated: (created) => { if (created) commit({ speciesId: created.id, confidence }); },
      });
    });
    wrap.append(button);
    return wrap;
  }

  function paintFooter() {
    clear(footerText);
    confidenceWrap.hidden = !chosen;
    assign.disabled = !chosen;
    if (chosen) {
      assign.textContent = `Identify as ${chosen.commonName || chosen.scientificName}`;
      // No "Chosen" label here: the section right above the footer is titled
      // that, and the button below names the species again. The footer's job
      // is to keep the name in view while the candidate list is scrolled.
      footerText.append(
        el('span', 'identify-chosen', chosen.commonName || chosen.scientificName || 'Unnamed'),
      );
      const preview = Model.displayName({ confidence }, chosen);
      footerText.append(el('span', 'identify-preview', `Will read as “${preview}”.`));
    } else {
      assign.textContent = 'Identify';
      footerText.append(el('span', 'identify-hint',
        row.identified ? 'Pick a species to change the identification, or save your tags.' : 'Pick a species above, or save your tags and come back to it.'));
    }
  }

  /** One write: the tags, and the identification when there is one. */
  async function commit(changes) {
    collect();
    const next = { ...stored, characters: draftObs.characters, ...changes };
    if (await saveRecord('observations', next)) {
      close({ force: true });
      render();
    }
  }

  // An existing identification can be taken back off without picking another.
  if (row.identified) {
    const clear_ = el('button', 'ghost-button', 'Clear identification');
    clear_.type = 'button';
    clear_.title = 'Keep the find and its tags, drop the name.';
    clear_.addEventListener('click', () => commit({ speciesId: null, confidence: 'high' }));
    left.append(clear_);
  }

  redraw();
}

// --- the glossary -----------------------------------------------------------

/**
 * Every term the log knows, what it means, and what it is classified as.
 *
 * Also the one place a category is set. It used to be a click on the tag
 * wherever it appeared, which made a global fact look like a local edit —
 * reclassifying `angular` on one mushroom said nothing about the next.
 */
function glossaryRows(rows) {
  const used = new Map();
  for (const s of state.species) {
    for (const spec of Model.FUNGI_CHARACTERS) {
      for (const t of Model.character(s, spec.id).tags) {
        const k = Model.normalizeTag(t.text);
        const e = used.get(k) || { uses: 0, characters: new Set() };
        e.uses += 1;
        e.characters.add(spec.label);
        used.set(k, e);
      }
    }
  }
  // Terms tagged on observations count too — they are the ones you are keying
  // with, and a term used only in the field is the one most worth defining.
  for (const r of rows) {
    for (const spec of Model.FUNGI_CHARACTERS) {
      for (const t of Model.character(r, spec.id).tags) {
        const k = Model.normalizeTag(t.text);
        const e = used.get(k) || { uses: 0, characters: new Set() };
        e.uses += 1;
        e.characters.add(spec.label);
        used.set(k, e);
      }
    }
  }

  // Measurements are values, not vocabulary — "3-10 cm" has nothing to define
  // and would bury the words that do.
  const terms = new Set([...Object.keys(state.glossary.terms || {}), ...used.keys()]);
  const all = [...terms];
  return all.filter((t) => Model.guessCategory(t, null) !== 'measure').map((term) => {
    const entry = state.glossary.terms[term] || {};
    const usage = used.get(term) || { uses: 0, characters: new Set() };
    return {
      term,
      definition: entry.definition || '',
      source: entry.source || '',
      override: entry.category || '',
      category: Model.classifyTag(term, null),
      guessed: Model.guessCategory(term, null),
      sameAs: entry.sameAs || '',
      synonyms: Model.synonymsOf(term, all),
      uses: usage.uses,
      characters: [...usage.characters],
    };
  }).sort((a, b) => a.term.localeCompare(b.term));
}

function renderGlossary({ rows }) {
  const all = glossaryRows(rows);
  const f = state.glossaryFilters;

  const undefinedCount = all.filter((t) => !t.definition).length;
  const unknownCount = all.filter((t) => t.category === 'note').length;

  clear($('glossary-filter-cat')).append(choiceDropdown({
    name: 'glossary-cat',
    label: 'Category',
    current: f.category,
    onPick: (id) => { f.category = id; render(); },
    options: [
      { id: 'all', label: 'All categories', count: all.length },
      // Each category carries the colour its tags are drawn in, so the list
      // reads the way the tags do.
      ...Model.TAG_CATEGORIES.map((c) => ({
        id: c.id,
        label: c.label,
        count: all.filter((t) => t.category === c.id).length,
        mark: categorySwatch(c.id),
      })),
    ],
  }));

  clear($('glossary-filter-state')).append(choiceDropdown({
    name: 'glossary-state',
    label: 'State',
    current: f.state,
    onPick: (id) => { f.state = id; render(); },
    options: [
      { id: 'all', label: 'Any state', count: all.length },
      { id: 'undefined', label: 'Undefined', count: undefinedCount },
      { id: 'unknown', label: 'Unclassified', count: unknownCount },
      { id: 'used', label: 'In use', count: all.filter((t) => t.uses).length },
    ],
  }));

  const q = f.q.trim().toLowerCase();
  const shown = all.filter((t) => {
    if (f.category !== 'all' && t.category !== f.category) return false;
    if (f.state === 'undefined' && t.definition) return false;
    if (f.state === 'unknown' && t.category !== 'note') return false;
    if (f.state === 'used' && !t.uses) return false;
    if (q && !(t.term.includes(q) || t.definition.toLowerCase().includes(q))) return false;
    return true;
  });

  $('glossary-note').textContent =
    `${all.length} terms · ${all.length - undefinedCount} defined · ${unknownCount} still unclassified.`;

  const body = clear($('glossary-rows'));
  if (!shown.length) {
    const tr = el('tr');
    const td = el('td');
    td.colSpan = 5;
    td.append(el('div', 'empty-state', 'No terms match.'));
    tr.append(td);
    body.append(tr);
  }
  for (const t of shown) body.append(glossaryRow(t));
  // scrollHeight only means anything once the rows are laid out.
  requestAnimationFrame(() => { for (const box of body.querySelectorAll('.glossary-def')) autosize(box); });

  const verdict = clear($('glossary-verdict'));
  if (unknownCount) {
    verdict.append(strongText(`${plural(unknownCount, 'term')} the vocabulary does not recognise.`),
      document.createTextNode(' They show dashed and grey wherever they are tagged. Set a category here and every use of the term follows.'));
  } else {
    verdict.append(strongText('Every term in use is classified.'));
  }
}

/** Match a textarea's height to its content, up to a sane ceiling. */
function autosize(box) {
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
}

function glossaryRow(t) {
  const tr = el('tr', t.uses ? null : 'is-muted');

  // The term, shown as the chip it renders as everywhere else.
  const termCell = el('td', 'nowrap gl-term');
  termCell.append(tagChip({ text: t.term, category: t.category }));
  tr.append(termCell);

  // The category, settable here and nowhere else.
  const catCell = el('td', 'nowrap gl-cat');
  const pick = select(Model.TAG_CATEGORIES, t.category);
  pick.addEventListener('change', () => setTermCategory(t.term, pick.value));
  catCell.append(pick);
  if (t.override) {
    const mark = el('span', 'glossary-set-by-hand', 'set by hand');
    mark.title = 'Overrides what the vocabulary would guess. Choose the guessed category again to clear it.';
    catCell.append(mark);
  }
  tr.append(catCell);

  // The definition, edited in place.
  const defCell = el('td', 'gl-def');
  const box = el('textarea', 'glossary-def');
  box.value = t.definition;
  box.rows = 1;
  box.placeholder = 'No definition yet';
  box.addEventListener('change', () => setTermDefinition(t.term, box.value));
  // Grow to the text rather than clipping it at one line. A definition you
  // have to scroll a one-line box to read is not much better than none.
  box.addEventListener('input', () => autosize(box));
  defCell.append(box);
  if (t.source) defCell.append(el('p', 'glossary-source', t.source));
  tr.append(defCell);

  const synCell = el('td', 'gl-same');
  if (t.synonyms.length) {
    const wrap = el('div', 'tag-list is-static');
    for (const syn of t.synonyms) wrap.append(tagChip({ text: syn, category: t.category }));
    synCell.append(wrap);
  }
  // Point this term at another and they become one term for matching.
  const same = input('text', t.sameAs, { placeholder: 'same as…', class: 'glossary-same' });
  same.title = 'Name another term this one means. Both then match as one.';
  same.addEventListener('change', () => setTermSameAs(t.term, same.value));
  synCell.append(same);
  tr.append(synCell);

  const useCell = el('td', 'r gl-uses');
  if (t.uses) {
    // The count is the question "which ones?" — so it answers it.
    const link = el('button', 'uses-link', String(t.uses));
    link.type = 'button';
    link.title = `Show the species tagged “${t.term}”`;
    link.addEventListener('click', () => setSpeciesTag(t.term));
    useCell.append(link);
  } else {
    useCell.append(document.createTextNode('0'));
  }
  if (t.characters.length) useCell.append(el('span', 'glossary-chars', t.characters.join(', ')));
  tr.append(useCell);

  return tr;
}

async function saveGlossary(terms) {
  const next = { ...state.glossary, terms };
  status('saving…');
  try {
    const payload = await request('api/glossary', 'PUT', next);
    state.glossary = payload.glossary;
    Model.applyGlossary(state.glossary);
    notice('');
    status('saved');
  } catch (err) {
    status('');
    if (err.status === 409) {
      notice(`${err.message}. Reloaded from disk — your last edit was not saved.`);
      await reloadState().catch(() => {});
    } else {
      notice(`Could not save: ${err.message}`);
    }
  }
  render();
}

/**
 * Choosing the category the vocabulary would have guessed clears the override
 * rather than pinning it. Storing a redundant override would freeze the term
 * against a later change to the word lists, which is the opposite of useful.
 */
function setTermCategory(term, category) {
  const terms = { ...state.glossary.terms };
  const entry = { ...(terms[term] || {}) };
  if (category === Model.guessCategory(term, null)) delete entry.category;
  else entry.category = category;
  terms[term] = entry;
  if (!entry.category && !entry.definition) delete terms[term];
  saveGlossary(terms);
}

/**
 * Point one term at another so they match as one.
 *
 * Self-reference and empty both clear it. A term pointed at itself would
 * resolve to itself, which is the same as no synonym but reads as a rule.
 */
function setTermSameAs(term, sameAs) {
  const target = Model.normalizeTag(sameAs);
  const terms = { ...state.glossary.terms };
  const entry = { ...(terms[term] || {}) };
  if (!target || target === Model.normalizeTag(term)) delete entry.sameAs;
  else entry.sameAs = target;
  terms[term] = entry;
  if (!entry.category && !entry.definition && !entry.sameAs) delete terms[term];
  saveGlossary(terms);
}

function setTermDefinition(term, definition) {
  const terms = { ...state.glossary.terms };
  terms[term] = { ...(terms[term] || {}), definition: definition.trim() };
  if (!terms[term].definition) delete terms[term].definition;
  saveGlossary(terms);
}

// --- the species sheet ------------------------------------------------------

function openSpeciesSheet(id, { kind, onCreated, seed } = {}) {
  const stored = id ? state.species.find((s) => s.id === id) : null;
  if (id && !stored) return;
  openSheet((sheet, close) => buildSpeciesSheet(sheet, stored, close, { kind, onCreated, seed }));
}

function buildSpeciesSheet(sheet, stored, close, { kind, onCreated, seed } = {}) {
  const creating = !stored;
  const record = stored || {
    id: uid(), version: 0, kind: kind || state.config?.nature?.defaultType || 'fungi',
    commonName: '', scientificName: '', habitat: '', notes: '',
    edibility: 'unknown', lookalikes: '',
    division: '', nutrition: 'unknown', characters: {}, formerNames: [], synonyms: [], photos: [],
    // A species adopted from somebody else's record arrives with its names
    // filled in; the identification is still yours to make.
    ...(seed || {}),
  };

  const head = sheetHead(sheet, record.commonName || (creating ? 'New species' : 'Unnamed'), record.scientificName, close, { unknown: !record.commonName });

  const form = el('form');
  watchEdits(form);

  const commonPick = input('text', record.commonName, { placeholder: 'Golden chanterelle' });
  const scientificPick = input('text', record.scientificName, { placeholder: 'Cantharellus formosus' });
  const kindPick = select(Model.TYPES, record.kind);
  const habitatPick = input('text', record.habitat, { placeholder: 'Douglas fir duff, mossy slopes' });
  const notesPick = el('textarea');
  notesPick.value = record.notes || '';

  commonPick.addEventListener('input', () => {
    head.title.textContent = commonPick.value || 'Unnamed';
    head.title.classList.toggle('is-unknown', !commonPick.value);
  });
  scientificPick.addEventListener('input', () => { head.sub.textContent = scientificPick.value; });

  const rowA = el('div', 'entry-row');
  rowA.append(
    field('Common name', commonPick, { grow: true }),
    field('Scientific name', scientificPick, { grow: true }),
    field('Type', kindPick, {}),
  );
  const ediblePick = select(Model.EDIBILITY, record.edibility || 'unknown');
  const lookalikePick = input('text', record.lookalikes || '', { placeholder: 'False chanterelle; Jack-o’-lantern' });

  const rowB = el('div', 'entry-row');
  rowB.append(
    field('Habitat', habitatPick, { grow: true }),
    field('Edibility', ediblePick, {}),
    field('Lookalikes', lookalikePick, { grow: true }),
    field('Notes', notesPick, { wide: true }),
  );
  form.append(rowA, rowB);

  // Shown only once something has been claimed about eating it. A caution
  // under every species would be noise; under this one it is the point.
  const caution = el('p', 'edible-caution');
  const syncCaution = () => {
    const meta = Model.edibility(ediblePick.value);
    caution.hidden = meta.id === 'unknown';
    caution.classList.toggle('is-dubious', meta.id === 'dubious');
    if (meta.id === 'dubious') {
      caution.textContent = 'Eaten by some people and not tolerated by others. Record who reports what, and what the reaction was — that disagreement is the whole content of this rating.';
    } else if (meta.id === 'choice' || meta.id === 'edible') {
      caution.textContent = 'Your own note, not an authority. Confirm against a key and a second source before eating anything — and record the lookalikes.';
    } else {
      caution.textContent = 'Recorded as not for eating. Worth writing down what it can be mistaken for.';
    }
  };
  ediblePick.addEventListener('change', syncCaution);
  syncCaution();
  form.append(caution);

  // --- look the name up
  // iNaturalist knows the accepted name and the common one; typing both by
  // hand is how a library ends up with three spellings of the same fungus.
  // Kept so the map can later ask iNaturalist for this exact taxon.
  let pickedTaxonId = record.inatTaxonId ?? null;

  const lookupRow = el('div', 'entry-row');
  const lookupBox = input('text', '', { placeholder: 'A name, or part of one' });
  const lookupGo = el('button', 'ghost-button', 'Look up');
  lookupGo.type = 'button';
  const lookupOut = el('div', 'lookup-results');

  const runLookup = async () => {
    const q = lookupBox.value.trim() || commonPick.value.trim() || scientificPick.value.trim();
    if (!q) return;
    clear(lookupOut).append(el('p', 'muted', 'Searching iNaturalist…'));
    try {
      const iconic = { fungi: 'Fungi', flora: 'Plantae', fauna: 'Animalia' }[kindPick.value];
      const payload = await request(`api/inat/taxa?q=${encodeURIComponent(q)}${iconic ? `&iconic=${iconic}` : ''}`, 'GET');
      clear(lookupOut);
      if (payload.problem) { lookupOut.append(el('p', 'muted', payload.problem)); return; }
      if (!payload.results.length) { lookupOut.append(el('p', 'muted', 'Nothing found.')); return; }
      for (const hit of payload.results) lookupOut.append(lookupHit(hit, () => {
        // Offered, never applied on its own: the names go in, and everything
        // else about the species stays yours.
        if (hit.commonName) { commonPick.value = hit.commonName; commonPick.dispatchEvent(new Event('input')); }
        if (hit.scientificName) { scientificPick.value = hit.scientificName; scientificPick.dispatchEvent(new Event('input')); }
        if (hit.type) { kindPick.value = hit.type; syncKind(); }
        // Held in the editor, not written onto the stored record: cancelling
        // the sheet has to leave the species exactly as it was.
        pickedTaxonId = hit.id;
        markDirty();
        clear(lookupOut);
      }));
    } catch (err) {
      clear(lookupOut).append(el('p', 'muted', `Lookup failed: ${err.message}`));
    }
  };
  lookupGo.addEventListener('click', runLookup);
  lookupBox.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); runLookup(); } });
  lookupRow.append(field('Look up a name', lookupBox, { grow: true, hint: 'Searches iNaturalist and fills the names in.' }), lookupGo);
  form.append(lookupRow, lookupOut);

  // --- fungal characters
  // Shown only for fungi. Division, gills and stipe are the first cuts in any
  // key, and they belong to the species, not to a single find of it.
  const traits = el('fieldset', 'trait-set');
  traits.append(el('legend', null, 'Fungal characters'));
  const divisionPick = input('text', record.division || '', { placeholder: 'Basidiomycota' });
  const nutritionPick = select(Model.NUTRITION, record.nutrition || 'unknown');
  const traitRow = el('div', 'entry-row');
  traitRow.append(
    field('Subkingdom / division', divisionPick, { grow: true }),
    field('Nutrition', nutritionPick, {}),
  );
  traits.append(traitRow);

  traits.append(el('p', 'character-note',
    'Type a tag and press Enter. No tags means not recorded; tick N/A when the species genuinely has no such structure. Tags colour themselves by what they are — a term\u2019s category is set in the Glossary.'));

  const grid = el('div', 'characters');
  const characterFields = Model.FUNGI_CHARACTERS.map((spec) => {
    const cell = tagField(spec, Model.character(record, spec.id), markDirty);
    grid.append(cell.node);
    return cell;
  });
  traits.append(grid);

  const former = nameListEditor(record.formerNames || [], 'A name it used to go by');
  const formerWrap = el('div');
  formerWrap.append(el('span', 'field-label', 'Former scientific names'), former.node);
  formerWrap.style.marginTop = '10px';
  traits.append(formerWrap);

  /*
   * Other current names for the same organism — not former ones. A guide and
   * iNaturalist can simply disagree: the western matsutake is Tricholoma
   * magnivelare in the book and T. murrillianum online, and records exist
   * under both. Every name here is searched when looking the species up.
   */
  const synonyms = nameListEditor(record.synonyms || [], 'Another accepted name');
  const synonymWrap = el('div');
  synonymWrap.append(el('span', 'field-label', 'Also known as'), synonyms.node);
  synonymWrap.append(el('p', 'field-hint',
    'A different name for the same organism, current elsewhere. All of these are searched on iNaturalist.'));
  synonymWrap.style.marginTop = '10px';
  traits.append(synonymWrap);

  const syncKind = () => { traits.hidden = kindPick.value !== 'fungi'; };
  kindPick.addEventListener('change', syncKind);
  syncKind();
  form.append(traits);

  const editor = sheetSection(sheet, creating ? 'New species' : 'The species');
  editor.append(form);

  // --- example photographs
  const tray = makeTray({ existing: record.photos || [], onChange: markDirty, addBelow: true, note: 'Reference shots — what a good one looks like.' });
  /*
   * Your own finds first, then the reference shots.
   *
   * When you have met the species, your photographs of it are the ones worth
   * seeing; the borrowed reference shots are what you check against. The
   * section is omitted entirely rather than showing an empty state — most of
   * the library has never been found, and 400 records each announcing that
   * they have not is noise.
   */
  if (!creating) {
    const mine = Model.sortByDate(Model.viewAll(state.observations, state.species).filter((r) => r.species?.id === record.id));
    if (mine.length) {
      const section = sheetSection(sheet, 'Finds', `${plural(mine.length, 'observation')} of this species.`);
      const gallery = el('div', 'gallery');
      for (const row of mine) gallery.append(findCard(row));
      section.append(gallery);
    }
  }

  sheetSection(sheet, 'Example photographs', 'Kept on the species, separate from any one find.').append(tray.node);

  // --- actions
  const actions = el('div', 'form-actions');
  if (!creating) {
    const remove = el('button', 'ghost-button is-danger', 'Delete');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      const uses = state.observations.filter((o) => o.speciesId === record.id).length;
      const warning = uses
        ? `Delete this species? ${plural(uses, 'find')} will go back to reading as unidentified.`
        : 'Delete this species?';
      if (!confirm(warning)) return;
      if (await deleteRecord('species', record.id)) {
        close({ force: true });
        render();
      }
    });
    actions.append(remove);
  }

  const save = el('button', 'solid-button', creating ? 'Create' : 'Save');
  save.type = 'button';
  save.addEventListener('click', async () => {
    if (tray.busy()) { notice('A photo is still uploading.'); return; }
    if (!commonPick.value.trim() && !scientificPick.value.trim()) {
      notice('A species needs at least one name.');
      return;
    }
    const next = {
      ...record,
      inatTaxonId: pickedTaxonId,
      kind: kindPick.value,
      commonName: commonPick.value.trim(),
      scientificName: scientificPick.value.trim(),
      habitat: habitatPick.value.trim(),
      notes: notesPick.value.trim(),
      edibility: ediblePick.value,
      lookalikes: lookalikePick.value.trim(),
      photos: tray.photos(),
      // Fungal characters are only meaningful on a fungus. Clearing them on a
      // reclassification stops a plant carrying a stale "bruises blue".
      division: kindPick.value === 'fungi' ? divisionPick.value.trim() : '',
      nutrition: kindPick.value === 'fungi' ? nutritionPick.value : 'unknown',
      characters: kindPick.value === 'fungi' ? readCharacters(characterFields) : {},
      formerNames: kindPick.value === 'fungi' ? former.values() : [],
      synonyms: kindPick.value === 'fungi' ? synonyms.values() : [],
    };
    // The two tri-states the characters replaced. Dropped on save so a
    // migrated record cannot carry two competing answers about its gills.
    delete next.gills;
    delete next.stipe;
    if (await saveRecord('species', next)) {
      close({ force: true });
      render();
      onCreated?.(next);
    }
  });
  actions.append(el('span', 'save-status spacer', ''), save);
  sheet.append(actions);

  // Cancelling a create has to tell the caller, or a picker sitting on the
  // "+ New species…" sentinel is left there.
  if (creating && onCreated) {
    const wrapped = state.closeSheet;
    state.closeSheet = (opts) => { wrapped(opts); };
  }
}

/** One iNaturalist match, offered as a button rather than applied. */
function lookupHit(hit, onPick) {
  const button = el('button', 'lookup-hit');
  button.type = 'button';
  if (hit.photo) {
    const img = el('img');
    img.src = hit.photo;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.replaceWith(el('span', 'no-preview', '🖼')), { once: true });
    button.append(img);
  } else {
    button.append(el('span', 'no-preview', '🖼'));
  }
  const body = el('div');
  body.append(el('div', 'lookup-hit-name', hit.commonName || hit.scientificName));
  body.append(el('div', 'lookup-hit-sci', `${hit.scientificName}${hit.rank && hit.rank !== 'species' ? ` · ${hit.rank}` : ''}`));
  button.append(body);
  if (hit.observations) button.append(el('span', 'lookup-hit-count', `${hit.observations.toLocaleString('en-US')} obs`));
  button.addEventListener('click', onPick);
  return button;
}

/**
 * A chip for one tag: its colour comes from its category, and a colour tag
 * paints the colour it names.
 *
 * `onCycle` makes the label a button that walks the categories. The vocabulary
 * only guesses, and a guess with no way to correct it is worse than no guess —
 * so every tag can be reclassified in place.
 */
/*
 * What a tag means, on a pause.
 *
 * The vocabulary is the part of this log that has to be learned, and the
 * definitions already exist in the Glossary — they were just two views away
 * from the moment you need them, which is while reading a species and meeting
 * "hygrophanous" for the third time.
 *
 * A second of hover, not instant: tags sit in dense rows, and a tooltip that
 * fires on the way past is a flicker, not a help.
 */
const TAG_TIP_DELAY = 1000;
let tagTipTimer = null;
let tagTipNode = null;

function tagTipElement() {
  if (tagTipNode) return tagTipNode;
  const node = el('div', 'tag-tip');
  node.hidden = true;
  // Never intercepts a click: the chip underneath may carry a remove button,
  // and a tooltip that eats that click is worse than no tooltip.
  document.body.append(node);
  tagTipNode = node;
  return node;
}

function hideTagTip() {
  clearTimeout(tagTipTimer);
  if (tagTipNode) tagTipNode.hidden = true;
}

function showTagTip(chip, tag) {
  const key = Model.normalizeTag(tag.text);
  const terms = state.glossary?.terms || {};
  const entry = terms[key];
  const synonyms = Model.synonymsOf(tag.text, Object.keys(terms));

  const tip = clear(tagTipElement());
  tip.append(el('div', 'tag-tip-term', key));

  const definition = (entry?.definition || '').trim();
  if (definition) {
    tip.append(el('p', 'tag-tip-def', definition));
  } else {
    // Worth saying rather than showing nothing: an undefined term is a gap in
    // the glossary, and this is exactly the moment it is noticed.
    tip.append(el('p', 'tag-tip-none', 'Not defined yet \u2014 add one in the Glossary.'));
  }

  if (synonyms.length) {
    const row = el('p', 'tag-tip-same');
    row.append(el('span', 'tag-tip-label', 'Same as'), document.createTextNode(synonyms.join(', ')));
    tip.append(row);
  }
  tip.append(el('p', 'tag-tip-cat', Model.tagCategory(tag.category).label));

  placeTip(tip, chip.getBoundingClientRect());
}

/**
 * Under the thing hovered, nudged back inside the viewport, flipped above when
 * there is no room below. Measured after the content is in, because the height
 * depends on how much there was to say.
 */
function placeTip(tip, box, { gap = 6, centre = false } = {}) {
  tip.hidden = false;
  const size = tip.getBoundingClientRect();
  const margin = 8;
  let left = centre ? box.left + box.width / 2 - size.width / 2 : box.left;
  if (left + size.width > window.innerWidth - margin) left = window.innerWidth - size.width - margin;
  if (left < margin) left = margin;
  let top = box.bottom + gap;
  if (top + size.height > window.innerHeight - margin) top = box.top - size.height - gap;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(Math.max(margin, top))}px`;
}

/** Arm one chip. Hover to show, anything else to put it away. */
function armTagTip(chip, tag) {
  chip.addEventListener('mouseenter', () => {
    clearTimeout(tagTipTimer);
    tagTipTimer = setTimeout(() => showTagTip(chip, tag), TAG_TIP_DELAY);
  });
  chip.addEventListener('mouseleave', hideTagTip);
  // A chip can be removed or re-rendered out from under an open tooltip.
  chip.addEventListener('click', hideTagTip);
}

/** The colour a category's tags are drawn in, as a chip for a menu row. */
function categorySwatch(category) {
  const dot = el('span', 'cat-swatch');
  dot.dataset.category = category;
  return dot;
}

function tagChip(tag, { onCycle, onRemove, tip = true } = {}) {
  const chip = el('span', 'tag');
  chip.dataset.category = tag.category;

  if (tag.category === 'colour') {
    const swatch = el('span', 'tag-swatch');
    const paint = Model.tagSwatch(tag.text);
    if (paint) swatch.style.background = paint;
    chip.append(swatch);
  }

  // Not clickable. A term's category is a property of the term, not of one
  // usage, so it is set once in the Glossary rather than per species here.
  //
  // No `title` here: the browser's own tooltip fires on roughly the same delay
  // as the glossary one and lands on top of it, hiding the definition behind
  // the category — which the glossary tooltip already names at its foot.
  const label = el('span', 'tag-text', tag.text);
  chip.append(label);
  void onCycle;

  if (onRemove) {
    const drop = el('button', 'tag-drop', '×');
    drop.type = 'button';
    drop.setAttribute('aria-label', `Remove ${tag.text}`);
    drop.addEventListener('click', onRemove);
    chip.append(drop);
  }
  if (tip) armTagTip(chip, tag);
  return chip;
}

/**
 * One character, as a bag of tags.
 *
 * Prose was the first attempt and it could not be queried — "neither gills nor
 * pores" matched a search for pores. A tag is a thing the species either has
 * or does not, which is what a key asks and what a search should answer.
 *
 * The N/A tick still means what it meant: no tags is "nobody has looked",
 * ticked is "there is no such structure". Ticking it puts the absence wording
 * in place of the input rather than leaving an empty row that reads unfinished.
 */
function tagField(spec, value, onChange) {
  const cell = el('div', 'character');
  const tags = value.tags.map((t) => ({ ...t }));

  const head = el('div', 'character-head');
  head.append(el('span', 'character-label', spec.label));
  const naBox = el('input');
  naBox.type = 'checkbox';
  // A character that cannot be absent gets no tick at all. Offering one that
  // must never be used is worse than offering none: it reads as a question
  // with a wrong answer available.
  naBox.checked = spec.alwaysPresent ? false : value.na;
  if (!spec.alwaysPresent) {
    const naLabel = el('label', 'character-na');
    naLabel.title = spec.absent;
    naLabel.append(naBox, document.createTextNode('N/A'));
    head.append(naLabel);
  }
  cell.append(head);

  const list = el('div', 'tag-list');
  const absentLine = el('p', 'tag-absent', spec.absent);

  // A datalist was the first attempt: one element, keyboard-friendly, and on a
  // phone the platform's own picker. But it dumps every term as unstyled text
  // in one undifferentiated list, and at fifty-odd options that is not a menu,
  // it is a wall. This shows the terms as the chips they will become, grouped
  // by category and ranked by use.
  const suggestions = el('div', 'tag-suggest');
  suggestions.hidden = true;

  const box = input('text', '', { placeholder: 'Add a tag…', autocomplete: 'off' });

  const changed = () => { draw(); if (!suggestions.hidden) drawSuggestions(); onChange?.(); };

  const removeAt = (i) => { tags.splice(i, 1); changed(); };

  function draw() {
    clear(list);
    tags.forEach((tag, i) => {
      list.append(tagChip(tag, { onRemove: () => removeAt(i) }));
    });
    list.append(box);
  }

  const commit = () => {
    const raw = box.value.trim();
    box.value = '';
    if (!raw) return;
    // Split on commas so a pasted list arrives as separate tags.
    for (const part of raw.split(',')) {
      const text = part.trim();
      if (!text) continue;
      if (tags.some((t) => Model.normalizeTag(t.text) === Model.normalizeTag(text))) continue;
      tags.push(Model.readTag(text, spec));
    }
    changed();
    box.focus();
  };

  box.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !suggestions.hidden) { ev.stopPropagation(); closeSuggestions(); return; }
    if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); commit(); return; }
    // Backspace in an empty box takes the last tag back, the way every tag
    // field people already use behaves.
    if (ev.key === 'Backspace' && !box.value && tags.length) { ev.preventDefault(); removeAt(tags.length - 1); }
  });
  // Committing on blur stops a typed-but-unentered tag being silently lost
  // when the sheet is saved.
  box.addEventListener('blur', commit);

  const wrap = el('div', 'tag-wrap');
  wrap.append(list, absentLine, suggestions);
  cell.append(wrap);

  function drawSuggestions() {
    const groups = tagSuggestions(spec, box.value, tags);
    clear(suggestions);
    if (!groups.length) {
      suggestions.append(el('p', 'tag-suggest-empty',
        box.value.trim() ? 'No known term matches — press Enter to add it anyway.' : 'Nothing to suggest.'));
      return;
    }
    for (const group of groups) {
      const row = el('div', 'tag-suggest-group');
      const label = el('span', 'tag-suggest-label', group.category.label);
      if (group.total > group.terms.length) {
        label.append(el('span', 'tag-suggest-more', `${group.total - group.terms.length} more`));
      }
      row.append(label);
      const chips = el('div', 'tag-list is-static');
      for (const term of group.terms) {
        // No glossary tooltip on these: they carry their own, saying how often
        // the term has been used here, and two tooltips on one chip is the
        // problem being avoided. This is a picking surface, not a reading one.
        const chip = tagChip(term, { tip: false });
        chip.classList.add('is-suggestion');
        chip.title = term.here ? `Used ${plural(term.here, 'time')} under ${spec.label}` : 'Not used here yet';
        // mousedown, not click: the input must not blur first, or its own blur
        // handler commits whatever half-typed text is sitting in it.
        chip.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          box.value = term.text;
          commit();
          drawSuggestions();
        });
        chips.append(chip);
      }
      row.append(chips);
      suggestions.append(row);
    }
  }

  const openSuggestions = () => { if (naBox.checked) return; drawSuggestions(); suggestions.hidden = false; };
  const closeSuggestions = () => { suggestions.hidden = true; };

  box.addEventListener('focus', openSuggestions);
  box.addEventListener('click', openSuggestions);
  box.addEventListener('input', () => { if (!suggestions.hidden) drawSuggestions(); });
  box.addEventListener('blur', closeSuggestions);

  const sync = () => {
    cell.classList.toggle('is-na', naBox.checked);
    list.hidden = naBox.checked;
    absentLine.hidden = !naBox.checked;
    if (naBox.checked) closeSuggestions();
  };
  naBox.addEventListener('change', () => { sync(); onChange?.(); });
  sync();
  draw();

  return { spec, node: cell, read: () => ({ na: naBox.checked, tags: naBox.checked ? [] : tags.map((t) => ({ ...t })) }) };
}

/** Only what was actually said, so the file does not fill with empty keys. */
function readCharacters(fields) {
  const out = {};
  for (const f of fields) {
    const value = f.read();
    if (value.na || value.tags.length) out[f.spec.id] = value;
  }
  return out;
}

/** Chips with a × each, plus a box to add another. */
function nameListEditor(initial, placeholder) {
  const values = [...(initial || [])];
  const wrap = el('div');
  const list = el('ul', 'former-names');

  const draw = () => {
    clear(list);
    for (const name of values) {
      const item = el('li');
      item.append(el('span', null, name));
      const drop = el('button', 'link-button', '×');
      drop.type = 'button';
      drop.setAttribute('aria-label', `Remove ${name}`);
      drop.addEventListener('click', () => {
        values.splice(values.indexOf(name), 1);
        draw();
        markDirty();
      });
      item.append(drop);
      list.append(item);
    }
    if (!values.length) list.append(el('li', 'muted', 'None recorded'));
  };

  const box = input('text', '', { placeholder });
  const add = el('button', 'ghost-button', 'Add');
  add.type = 'button';
  const commit = () => {
    const name = box.value.trim();
    if (!name || values.includes(name)) { box.value = ''; return; }
    values.push(name);
    box.value = '';
    draw();
    markDirty();
  };
  add.addEventListener('click', commit);
  // Enter inside a form submits it; here it means "add this name".
  box.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } });

  const row = el('div', 'entry-row');
  row.style.marginTop = '8px';
  row.append(field('', box, { grow: true }), add);
  wrap.append(list, row);
  draw();
  return { node: wrap, values: () => [...values] };
}

// --- wiring -----------------------------------------------------------------

function wire() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }
  window.addEventListener('popstate', () => {
    // Set these first: setView renders, and would otherwise draw the old ones.
    state.mode = modeFromUrl();
    state.speciesFilters.tag = tagFromUrl();
    setView(viewFromUrl(), { push: false });
  });

  obsTray = makeTray({
    zone: $('obs-drop'),
    fileInput: $('obs-file'),
    strip: $('obs-shots'),
    onChange: () => { adoptMetadata(obsTray.photos()); syncObsForm(); },
  });

  $('obs-form').addEventListener('submit', submitObservation);
  $('obs-reset').addEventListener('click', () => { resetObsForm(); notice(''); });

  $('filter-q').addEventListener('input', (ev) => { state.filters.q = ev.target.value; render(); });
  $('filter-sp-q').addEventListener('input', (ev) => { state.speciesFilters.q = ev.target.value; renderSpeciesTable(derive().life); });
  $('species-new').addEventListener('click', () => openSpeciesSheet(null, {}));
  $('glossary-q').addEventListener('input', (ev) => { state.glossaryFilters.q = ev.target.value; render(); });
  $('filter-species').addEventListener('change', (ev) => {
    state.filters.speciesId = ev.target.value;
    // Picking a species is what asks iNaturalist anything at all.
    loadInat();
    render();
  });
  for (const [id, mode] of [['mode-finds', 'finds'], ['mode-map', 'map']]) {
    $(id).addEventListener('click', () => setMode(mode));
  }
  // Logging is one action and not the thing you come here to look at, so the
  // form stays out of the way until asked for.
  $('entry-toggle').addEventListener('click', () => {
    const open = $('entry-body').hidden;
    $('entry-body').hidden = !open;
    $('entry-toggle').setAttribute('aria-expanded', String(open));
    $('entry-block').classList.toggle('is-open', open);
    if (open) $('obs-drop').focus();
  });
  wireSortHeaders('species-head', state.speciesSort, () => render());

  $('scrim').addEventListener('click', (ev) => {
    // Only a click on the backdrop itself closes; one that started inside the
    // sheet and drifted out while selecting text must not.
    if (ev.target === $('scrim')) state.closeSheet?.();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('scrim').hidden) state.closeSheet?.();
  });

  // Chart type is sized against the rendered width, so a resize has to redraw.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.view === 'log' && state.mode === 'map') mapView?.redraw(); }, 150);
  });
}

async function boot() {
  try {
    const payload = await request('api/state', 'GET');
    state.config = payload.config;
    state.observations = payload.observations || [];
    state.species = payload.species || [];
    state.glossary = payload.glossary || { version: 0, terms: {} };
    Model.applyGlossary(state.glossary);
    applyTheme(state.config.theme);

    fillTypeSelect($('obs-type'));
    wire();
    resetObsForm();
    // Normalise the URL on load so it always states the view, then render it.
    setView(viewFromUrl(), { push: false });
  } catch (err) {
    notice(`Could not load: ${err.message}`);
  }
}

function fillTypeSelect(node) {
  clear(node);
  for (const t of Model.TYPES) node.append(new Option(t.label, t.id));
}

boot();
