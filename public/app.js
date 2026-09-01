/* ==========================================================================
   Tracker — views and wiring. The log's rules live in model.js, and the
   photo-metadata reading in exif.js.

   The shape of the app follows the finances one: load everything in a single
   round trip, keep it in `state`, and re-render the whole active view after
   any change. At the scale of a personal log that is far cheaper than the
   bookkeeping a finer-grained update would need.
   ========================================================================== */

'use strict';

const VIEWS = ['log', 'map', 'species'];

const state = {
  config: null,
  observations: [],
  species: [],
  view: 'log',
  // View state, not saved: a filter is a way of looking at the log, not a
  // property of it.
  filters: { type: 'all', status: 'all', q: '' },
  speciesFilters: { type: 'all', q: '' },
  speciesSort: { col: 'commonName', key: 'commonName', dir: 'asc' },
  // The map's own filters, kept apart from the gallery's: looking at where the
  // chanterelles are is a different question from listing them.
  mapFilters: { type: 'all', speciesId: '', choiceOnly: false, showInat: false },
  mapSelection: null,
  inat: { results: [], loading: false, problem: null, box: null },
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

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, text) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
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

function typeBadge(type) {
  const badge = el('span', 'type-badge');
  badge.dataset.type = type;
  badge.append(el('span', 'glyph', Model.typeGlyph(type)), document.createTextNode(Model.typeLabel(type)));
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

function setView(view, { push = true } = {}) {
  state.view = VIEWS.includes(view) ? view : 'log';
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.view === state.view);
    tab.setAttribute('aria-selected', tab.dataset.view === state.view ? 'true' : 'false');
  }
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== state.view;
  // A map built or drawn while its tab was hidden measured a zero-width box.
  if (state.view === 'map' && mapView) requestAnimationFrame(() => mapView.redraw());
  if (push) {
    const url = new URL(location.href);
    url.searchParams.set('view', state.view);
    history.pushState({ view: state.view }, '', url);
  }
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

function shotCard(shot, onRemove) {
  const card = el('div', 'shot' + (shot.status === 'working' ? ' is-busy' : ''));
  const frame = el('div', 'shot-frame');

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
    if (!bits.length) bits.push('no EXIF');
    bits.push(fmtBytes(p.bytes));
    for (const [i, text] of bits.entries()) {
      const line = el('div', i < bits.length - 1 && p.hasExif ? 'has' : null, text);
      meta.append(line);
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
  else if (state.view === 'map') renderMap(d);
  else renderSpecies(d);
}

function renderMasthead({ rows, summary: s }) {
  $('chip-finds').textContent = s.total;
  $('chip-identified').textContent = s.total ? `${Math.round(s.identifiedShare * 100)}%` : '—';
  $('chip-identified-source').textContent = s.total ? `${s.identified} of ${s.total}` : 'nothing logged yet';
  $('chip-species').textContent = s.speciesSeen;

  const last = s.latest;
  $('chip-last').textContent = last ? last.name : '—';
  $('chip-last-source').textContent = last ? (last.when ? fmtDate(last.when) : 'undated') : 'no finds yet';

  // A span of one year reads as "2025", not "2025-2025".
  const span = Model.years(rows);
  const covered = span.length > 1 ? ` ${span[span.length - 1]}–${span[0]}.` : span.length ? ` ${span[0]}.` : '';
  $('log-caption').textContent = (state.config?.app?.tagline || 'Field notes.') + covered;
}

// --- the log view -----------------------------------------------------------

function renderLog({ rows, summary: s }) {
  $('big-finds').textContent = s.total;
  $('finds-caption').textContent = s.total
    ? `${s.identified} identified, ${s.unidentified} still open`
    : 'Add a photo below to start.';
  $('big-species').textContent = s.speciesSeen;
  $('species-caption').textContent = s.speciesSeen
    ? `distinct species behind ${plural(s.identified, 'find')}`
    : 'none identified yet';

  for (const type of Model.TYPE_IDS) $(`stat-${type}`).textContent = s.counts[type];
  $('stat-unidentified').textContent = s.unidentified;
  $('stat-uncertain').textContent = s.uncertain;
  $('stat-placed').textContent = s.placed;
  $('stat-choice').textContent = Model.choiceFinds(rows).length;

  renderLogVerdict(rows, s);
  renderSeason(rows);
  renderFilters(rows);
  renderGallery(rows);
}

/**
 * One sentence about the state of the log. The useful one is almost always the
 * backlog: an unidentified pile is a to-do list, and an uncertain one is a
 * re-check list.
 */
function renderLogVerdict(rows, s) {
  const node = $('log-verdict');
  clear(node);
  if (!s.total) {
    node.textContent = 'Nothing logged yet. A photo is enough to start — the species can wait.';
    return;
  }
  const parts = [];
  if (s.unidentified) parts.push(`${plural(s.unidentified, 'find')} still unidentified`);
  if (s.uncertain) parts.push(`${plural(s.uncertain, 'identification')} marked uncertain`);
  if (!parts.length) {
    node.append(document.createTextNode('Everything logged is identified and settled. '), strongText(`${plural(s.speciesSeen, 'species')} on the life list.`));
    return;
  }
  node.append(strongText(parts.join(', ')), document.createTextNode(`. ${s.placed} of ${s.total} carry a location.`));
}

const strongText = (text) => el('strong', null, text);

/** Stacked bars: finds per calendar month, split by kingdom. */
function renderSeason(rows) {
  const svg = clear($('chart-season'));
  const W = 760, H = 240;
  const padL = 36, padR = 14, padT = 20, padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { months, dated, peak } = Model.byMonth(rows);

  if (!dated) {
    svg.append(svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, 'No dated finds yet'));
    $('season-note').textContent = 'Finds by calendar month. Nothing dated to plot yet.';
    clear($('season-legend'));
    sizeChart(svg, W);
    return;
  }

  // A y-axis in whole finds. Fractional gridlines on a count are nonsense, so
  // the step is forced to at least 1 and the top rounded up onto it.
  const rawMax = Math.max(1, peak.total);
  const step = Math.max(1, Math.ceil(rawMax / 4));
  const top = step * Math.ceil(rawMax / step);
  const y = (v) => padT + plotH - (v / top) * plotH;

  for (let v = 0; v <= top; v += step) {
    svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? 'axis-line' : 'chart-grid' }));
    svg.append(svgEl('text', { x: padL - 7, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' }, String(v)));
  }

  const slot = plotW / 12;
  const barW = Math.min(38, slot * 0.62);
  months.forEach((m, i) => {
    const cx = padL + slot * (i + 0.5);
    let base = y(0);
    for (const type of Model.TYPE_IDS) {
      const n = m.counts[type];
      if (!n) continue;
      const h = (n / top) * plotH;
      svg.append(svgEl('rect', { x: cx - barW / 2, y: base - h, width: barW, height: h, class: `bar-${type}` }));
      base -= h;
    }
    svg.append(svgEl('text', { x: cx, y: H - padB + 18, 'text-anchor': 'middle', class: 'axis-text' }, m.label));
    if (m.total && m === peak) {
      svg.append(svgEl('text', { x: cx, y: base - 6, 'text-anchor': 'middle', class: 'chart-peak-label' }, 'Peak'));
    }
  });

  $('season-note').textContent = `${plural(dated, 'dated find')} across ${plural(Model.years(rows).length, 'year')}. Busiest month: ${peak.label}.`;

  const legend = clear($('season-legend'));
  const totals = Object.fromEntries(Model.TYPE_IDS.map((t) => [t, months.reduce((a, m) => a + m.counts[t], 0)]));
  for (const type of Model.TYPE_IDS) {
    const item = el('div', 'legend-item' + (totals[type] ? '' : ' is-zero'));
    const swatch = el('span', 'legend-swatch');
    swatch.style.background = `var(--${type})`;
    item.append(swatch, document.createTextNode(Model.typeLabel(type)), el('span', 'legend-value', String(totals[type])));
    legend.append(item);
  }

  sizeChart(svg, W);
}

/**
 * Hold chart text at a roughly constant physical size. Type is sized in viewBox
 * user units, so a chart scaled down to phone width would shrink its labels
 * with it; --chart-k is the inverse of that scale.
 */
function sizeChart(svg, viewBoxWidth) {
  const rendered = svg.clientWidth;
  svg.style.setProperty('--chart-k', rendered ? (viewBoxWidth / rendered).toFixed(3) : '1');
}

// --- filters ----------------------------------------------------------------

function renderFilters(rows) {
  const typeSet = clear($('filter-type'));
  const counts = Model.summary(rows).counts;
  typeSet.append(pill('All', state.filters.type === 'all', rows.length, () => { state.filters.type = 'all'; render(); }));
  for (const t of Model.TYPES) {
    typeSet.append(pill(t.label, state.filters.type === t.id, counts[t.id], () => { state.filters.type = t.id; render(); }));
  }

  const statusSet = clear($('filter-status'));
  const s = Model.summary(rows);
  const options = [
    { id: 'all', label: 'Any ID', count: s.total },
    { id: 'identified', label: 'Identified', count: s.identified },
    { id: 'unidentified', label: 'Unidentified', count: s.unidentified },
    { id: 'uncertain', label: 'Uncertain', count: s.uncertain },
  ];
  for (const o of options) {
    statusSet.append(pill(o.label, state.filters.status === o.id, o.count, () => { state.filters.status = o.id; render(); }));
  }
  statusSet.append(pill('Choice edible', !!state.filters.edible, Model.choiceFinds(rows).length, () => {
    state.filters.edible = !state.filters.edible;
    render();
  }));
}

function pill(label, on, count, onClick) {
  const button = el('button', 'pill' + (on ? ' is-on' : ''));
  button.type = 'button';
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  button.append(document.createTextNode(label));
  if (count != null) button.append(el('span', 'count', String(count)));
  button.addEventListener('click', onClick);
  return button;
}

// --- gallery ----------------------------------------------------------------

function renderGallery(rows) {
  const shown = Model.sortByDate(Model.filter(rows, state.filters));
  const gallery = clear($('finds-gallery'));

  $('finds-note').textContent = shown.length === rows.length
    ? `${plural(rows.length, 'find')}, newest first.`
    : `${shown.length} of ${rows.length} finds.`;

  if (!shown.length) {
    gallery.append(el('div', 'empty-state', rows.length ? 'No finds match these filters.' : 'The log is empty. Add a photo above.'));
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
  if (row.scientificName) body.append(el('p', 'find-sci sci', row.scientificName));

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

// --- the map view -----------------------------------------------------------

/** Pins are the map's own shape: position, how to draw it, what to say. */
function ownPins(rows) {
  return rows.filter((r) => r.hasPlace).map((r) => ({
    id: r.id,
    kind: 'mine',
    lat: r.lat,
    lon: r.lon,
    type: r.type,
    label: `${r.name} — ${fmtDate(r.when)}`,
    choice: Model.isChoice(r.species),
    dangerous: Model.isDangerous(r.species),
    row: r,
  }));
}

function inatPins(results) {
  const f = state.mapFilters;
  // Also filtered client-side, not just re-queried: the request is in flight
  // for a moment, and for that moment the overlay would otherwise show taxa
  // the lit filter says are hidden.
  return results.filter((o) => f.type === 'all' || o.type === f.type).map((o) => ({
    id: o.id,
    kind: 'inat',
    lat: o.lat,
    lon: o.lon,
    type: o.type,
    label: `${o.commonName || o.scientificName} — iNaturalist`,
    choice: false,
    dangerous: false,
    inat: o,
  }));
}

/** The map's filters, applied to the user's own finds. */
function mapVisible(rows) {
  const f = state.mapFilters;
  return rows.filter((r) => {
    if (!r.hasPlace) return false;
    if (f.type !== 'all' && r.type !== f.type) return false;
    if (f.speciesId && r.species?.id !== f.speciesId) return false;
    if (f.choiceOnly && !Model.isChoice(r.species)) return false;
    return true;
  });
}

function renderMap({ rows }) {
  const shown = mapVisible(rows);
  const placed = rows.filter((r) => r.hasPlace);

  renderMapFilters(rows);

  $('map-note').textContent = placed.length
    ? `${shown.length} of ${plural(placed.length, 'placed find')} shown. Drag to pan, scroll to zoom.`
    : 'No find carries a location yet. A photo with GPS switched on brings one with it.';

  if (!mapView) {
    const config = state.config?.map || {};
    mapView = MapView.create({
      node: $('map-canvas'),
      attribution: config.attribution || '',
      minZoom: config.minZoom ?? 2,
      maxZoom: config.maxZoom ?? 19,
      onSelect: (pin) => { state.mapSelection = pin; renderMapSelection(); },
      onViewChange: (box) => { state.inat.box = box; if (state.mapFilters.showInat) loadInat(); },
    });
    const start = config.default || { lat: 0, lon: 0, zoom: 2 };
    // Open on the finds if there are any; the configured default is only the
    // answer for an empty log.
    const found = MapView.fitBounds(placed, $('map-canvas').clientWidth || 800, $('map-canvas').clientHeight || 420, { maxZoom: config.maxZoom ?? 19 });
    mapView.setView(found || start, { silent: true });
    state.inat.box = mapView.bounds();
  }

  const pins = [...ownPins(shown), ...(state.mapFilters.showInat ? inatPins(state.inat.results) : [])];
  mapView.setPins(pins);
  // A tile layer drawn while the view was hidden measured a zero-width box.
  mapView.redraw();

  renderMapLegend(shown, pins);
  renderMapSelection();
  renderMapVerdict(shown, placed);
}

function renderMapFilters(rows) {
  const placed = rows.filter((r) => r.hasPlace);
  // The overlay is fetched per kingdom, so changing this filter is a new
  // question for iNaturalist, not just a redraw of what is already here.
  const pickType = (id) => {
    state.mapFilters.type = id;
    state.mapSelection = null;
    if (state.mapFilters.showInat) loadInat();
    render();
  };
  const set = clear($('map-filter-type'));
  set.append(pill('All', state.mapFilters.type === 'all', placed.length, () => pickType('all')));
  for (const t of Model.TYPES) {
    const n = placed.filter((r) => r.type === t.id).length;
    set.append(pill(t.label, state.mapFilters.type === t.id, n, () => pickType(t.id)));
  }

  const extra = clear($('map-filter-extra'));
  const choiceCount = placed.filter((r) => Model.isChoice(r.species)).length;
  extra.append(pill('Choice edibles', state.mapFilters.choiceOnly, choiceCount, () => {
    state.mapFilters.choiceOnly = !state.mapFilters.choiceOnly;
    render();
  }));
  if (state.config?.inaturalist?.enabled !== false) {
    const label = state.inat.loading ? 'iNaturalist…' : 'iNaturalist';
    extra.append(pill(label, state.mapFilters.showInat, state.mapFilters.showInat ? state.inat.results.length : null, () => {
      state.mapFilters.showInat = !state.mapFilters.showInat;
      state.mapSelection = null;
      if (state.mapFilters.showInat) loadInat();
      render();
    }));
  }

  // Only species actually placed on the map are worth offering: picking one
  // with no located find just empties the map with no explanation.
  const picker = $('map-species');
  const held = state.mapFilters.speciesId;
  clear(picker);
  picker.append(new Option('Any species', ''));
  const seen = new Map();
  for (const r of placed) if (r.species) seen.set(r.species.id, (seen.get(r.species.id) || 0) + 1);
  for (const sp of state.species) {
    if (!seen.has(sp.id)) continue;
    picker.append(new Option(`${sp.commonName || sp.scientificName} (${seen.get(sp.id)})`, sp.id));
  }
  picker.value = held;
  if (picker.selectedIndex === -1) { picker.value = ''; state.mapFilters.speciesId = ''; }
}

function renderMapLegend(shown, pins) {
  const legend = clear($('map-legend'));
  for (const t of Model.TYPES) {
    const n = shown.filter((r) => r.type === t.id).length;
    const item = el('div', 'legend-item' + (n ? '' : ' is-zero'));
    const swatch = el('span', 'legend-swatch');
    swatch.style.background = `var(--${t.id})`;
    swatch.style.borderRadius = '50%';
    item.append(swatch, document.createTextNode(t.label), el('span', 'legend-value', String(n)));
    legend.append(item);
  }
  if (state.mapFilters.showInat) {
    const picked = state.mapFilters.speciesId ? state.species.find((sp) => sp.id === state.mapFilters.speciesId) : null;
    const scoped = picked?.inatTaxonId ? `, ${picked.commonName || picked.scientificName} only` : '';
    const item = el('div', 'legend-item');
    const swatch = el('span', 'legend-swatch');
    swatch.style.cssText = 'border-radius:50%;border:2px solid var(--ink-soft);background:transparent';
    item.append(swatch, document.createTextNode(`Hollow: iNaturalist, research grade${scoped}`), el('span', 'legend-value', String(pins.filter((p) => p.kind === 'inat').length)));
    legend.append(item);
  }
}

function renderMapVerdict(shown, placed) {
  const node = clear($('map-verdict'));
  if (state.inat.problem) {
    node.append(strongText('iNaturalist is unreachable. '), document.createTextNode('Your own finds are unaffected.'));
    return;
  }
  if (!placed.length) {
    node.textContent = 'Locations come from the photograph. iPhone: Settings → Privacy → Location Services → Camera.';
    return;
  }
  const choice = shown.filter((r) => Model.isChoice(r.species)).length;
  node.append(
    strongText(`${plural(shown.length, 'pin')} on the map.`),
    document.createTextNode(choice ? ` ${plural(choice, 'find')} of a choice edible.` : ''),
  );
}

/** What a clicked pin says. Yours is editable; somebody else's links out. */
function renderMapSelection() {
  const holder = clear($('map-selection'));
  const pin = state.mapSelection;
  if (!pin) return;

  const card = el('div', 'map-selection');
  const shot = el('div', 'map-selection-shot');
  const src = pin.kind === 'mine' ? thumbSrc(coverOf(pin.row)) : pin.inat.photo;
  if (src) {
    const img = el('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    // An iNaturalist photo is fetched from their CDN by the browser; if it is
    // blocked or gone, fall back rather than showing a broken frame.
    img.addEventListener('error', () => { clear(shot).append(el('span', 'no-preview', Model.typeGlyph(pin.type))); }, { once: true });
    shot.append(img);
  } else {
    shot.append(el('span', 'no-preview', Model.typeGlyph(pin.type)));
  }
  card.append(shot);

  const body = el('div', 'map-selection-body');
  if (pin.kind === 'mine') {
    const row = pin.row;
    body.append(typeBadge(row.type));
    body.append(el('h3', 'map-selection-name' + (row.identified ? '' : ' is-unknown'), row.name));
    if (row.scientificName) body.append(el('p', 'find-sci sci', row.scientificName));
    if (row.species?.edibility && row.species.edibility !== 'unknown') body.append(edibleBadge(row.species.edibility));
    body.append(el('p', 'map-selection-meta', [fmtWhen(row.when), Model.formatCoord(row.lat, row.lon), row.place].filter(Boolean).join(' · ')));

    const actions = el('div', 'map-selection-actions');
    const open = el('button', 'ghost-button', 'Open find');
    open.type = 'button';
    open.addEventListener('click', () => openObservationSheet(row.id));
    actions.append(open);
    const link = Model.mapLink(row.lat, row.lon);
    if (link) actions.append(externalLink(link, 'View on OpenStreetMap'));
    body.append(actions);
  } else {
    const o = pin.inat;
    body.append(el('span', 'source-tag', 'iNaturalist · someone else'));
    body.append(typeBadge(pin.type));
    body.append(el('h3', 'map-selection-name', o.commonName || o.scientificName));
    if (o.scientificName) body.append(el('p', 'find-sci sci', o.scientificName));
    body.append(el('p', 'map-selection-meta', [o.observedOn ? fmtDate(o.observedOn) : null, o.by ? `by ${o.by}` : null, o.obscured ? 'location obscured' : null].filter(Boolean).join(' · ')));

    const actions = el('div', 'map-selection-actions');
    actions.append(externalLink(o.url, 'Open on iNaturalist'));
    // Turning somebody else's record into a species of your own is the useful
    // move here — it fills the names in, and leaves the identification yours.
    const adopt = el('button', 'ghost-button', 'Add as species');
    adopt.type = 'button';
    adopt.addEventListener('click', () => {
      openSpeciesSheet(null, {
        kind: pin.type,
        seed: { commonName: o.commonName || '', scientificName: o.scientificName || '' },
      });
    });
    actions.append(adopt);
    body.append(actions);
  }

  card.append(body);
  holder.append(card);
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

/**
 * Pull other people's records for whatever is currently on screen.
 *
 * Debounced, because panning fires this constantly and iNaturalist asks
 * callers to be gentle. A failure is reported quietly: the map still has your
 * own pins on it, which is the part that matters.
 */
let inatTimer = null;
function loadInat() {
  clearTimeout(inatTimer);
  inatTimer = setTimeout(async () => {
    const box = state.inat.box || mapView?.bounds();
    if (!box) return;
    state.inat.loading = true;
    renderMapFilters(derive().rows);

    const query = new URLSearchParams({
      swlat: box.swlat.toFixed(5), swlng: box.swlng.toFixed(5),
      nelat: box.nelat.toFixed(5), nelng: box.nelng.toFixed(5),
    });
    const iconic = { fungi: 'Fungi', flora: 'Plantae', fauna: 'Animalia' }[state.mapFilters.type];
    if (iconic) query.set('iconic', iconic);
    const picked = state.mapFilters.speciesId ? state.species.find((sp) => sp.id === state.mapFilters.speciesId) : null;
    if (picked?.inatTaxonId) query.set('taxon_id', String(picked.inatTaxonId));

    try {
      const payload = await request(`api/inat/observations?${query}`, 'GET');
      state.inat.results = payload.results || [];
      state.inat.problem = payload.problem || null;
    } catch (err) {
      state.inat.results = [];
      state.inat.problem = err.message;
    } finally {
      state.inat.loading = false;
      if (state.view === 'map') render();
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

function renderSpecies({ rows, life }) {
  const seen = life.filter((sp) => sp.seen);
  $('big-species-total').textContent = life.length;
  const unmetCount = life.length - seen.length;
  $('species-total-caption').textContent = life.length
    ? (unmetCount ? `${unmetCount} written up but not yet met` : 'all of them met in the field')
    : 'Nothing on file yet.';
  $('big-species-seen').textContent = seen.length;
  $('species-seen-caption').textContent = seen.length ? `behind ${plural(rows.filter((r) => r.identified).length, 'find')}` : 'no identified finds yet';

  for (const type of Model.TYPE_IDS) {
    $(`stat-sp-${type}`).textContent = life.filter((sp) => sp.kind === type).length;
  }
  $('stat-sp-choice').textContent = life.filter(Model.isChoice).length;
  $('stat-sp-danger').textContent = life.filter(Model.isDangerous).length;

  const unmet = life.length - seen.length;
  const verdict = clear($('species-verdict'));
  if (!life.length) {
    verdict.textContent = 'No species on file. Add one here, or from a find in the log.';
  } else {
    const most = [...life].sort((a, b) => b.count - a.count)[0];
    verdict.append(
      strongText(most.count ? `${most.commonName || most.scientificName} is the most-found, at ${plural(most.count, 'find')}.` : 'Nothing has been found twice yet.'),
      document.createTextNode(unmet ? ` ${plural(unmet, 'species')} on file with no find behind ${unmet === 1 ? 'it' : 'them'}.` : ''),
    );
  }

  renderSpeciesFilters(life);
  renderSpeciesTable(life);
}

function renderSpeciesFilters(life) {
  const set = clear($('filter-sp-type'));
  set.append(pill('All', state.speciesFilters.type === 'all', life.length, () => { state.speciesFilters.type = 'all'; render(); }));
  for (const t of Model.TYPES) {
    const n = life.filter((sp) => sp.kind === t.id).length;
    set.append(pill(t.label, state.speciesFilters.type === t.id, n, () => { state.speciesFilters.type = t.id; render(); }));
  }
  set.append(pill('Choice', state.speciesFilters.type === 'choice', life.filter(Model.isChoice).length, () => { state.speciesFilters.type = 'choice'; render(); }));
}

function renderSpeciesTable(life) {
  const q = state.speciesFilters.q.trim().toLowerCase();
  // Sorting on the id string would order these alphabetically — choice between
  // deadly and edible — which is exactly backwards for the column's purpose.
  const ranked = life.map((sp) => ({ ...sp, edibleRank: Model.edibility(sp.edibility).rank }));
  const shown = ranked.filter((sp) => {
    if (state.speciesFilters.type === 'choice') { if (!Model.isChoice(sp)) return false; }
    else if (state.speciesFilters.type !== 'all' && sp.kind !== state.speciesFilters.type) return false;
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
  const sorted = [...shown].sort((a, b) => sign * compare(a, b, spec.key) || compare(a, b, 'commonName'));

  paintSortHeaders('species-head', spec);

  const body = clear($('species-rows'));
  if (!sorted.length) {
    const tr = el('tr');
    const td = el('td');
    td.colSpan = 8;
    td.append(el('div', 'empty-state', life.length ? 'No species match these filters.' : 'Nothing on file yet.'));
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const sp of sorted) {
    const tr = el('tr', 'is-clickable' + (sp.seen ? '' : ' is-muted'));
    tr.append(cell(speciesThumb(sp), 'nowrap'));
    tr.append(cell(sp.commonName || el('span', 'muted', 'Unnamed')));
    tr.append(cell(sp.scientificName ? el('span', 'sci', sp.scientificName) : el('span', 'muted', '—')));
    tr.append(cell(typeBadge(sp.kind), 'nowrap'));
    tr.append(cell(sp.edibility && sp.edibility !== 'unknown' ? edibleBadge(sp.edibility) : el('span', 'muted', '—'), 'nowrap'));
    tr.append(cell(sp.habitat || el('span', 'muted', '—')));
    tr.append(cell(String(sp.count), 'r nowrap'));
    tr.append(cell(sp.last ? fmtDate(sp.last) : el('span', 'muted', 'never'), 'nowrap'));
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
function makeTray({ zone, fileInput, strip, existing, onChange, note } = {}) {
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
  if (node) node.append(zone, fileInput, strip);

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
  const sub = el('p', 'sheet-sub sci', subText || '');
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

  const typeHint = el('span', 'field-hint', ' ');
  const confidenceHint = el('span', 'field-hint', ' ');
  // Assigned once the traits section is built, below; sync() runs after that.
  let paintTraits = () => {};

  /** The title is derived, so it has to follow the controls, not the file. */
  const sync = () => {
    const chosen = speciesPick.value && speciesPick.value !== NEW_SPECIES
      ? state.species.find((s) => s.id === speciesPick.value)
      : null;
    typePick.disabled = !!chosen;
    if (chosen) typePick.value = chosen.kind;
    typeHint.textContent = chosen ? 'Follows the species.' : ' ';
    confidencePick.disabled = !chosen;
    confidenceHint.textContent = !chosen ? 'Identify it first.' : confidencePick.value === 'low' ? 'Shown as “name?”.' : ' ';

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
  rowA.querySelectorAll('label')[1].append(typeHint);
  rowA.querySelectorAll('label')[2].append(confidenceHint);

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
      state.mapSelection = null;
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
  const candList = el('div', 'candidates');
  candSection.append(candList);

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

  footer.append(footerText, confidenceWrap, saveTags, assign);
  sheet.append(footer);

  // --- behaviour

  function collect() {
    draftObs.characters = canTag ? readCharacters(fields) : {};
    markDirty();
  }

  function redraw() {
    const { rows, anyTags, pool } = Model.rankCandidates(draftObs, state.species);
    const tagCount = Model.observedTagCount(draftObs);

    candNote.textContent = !pool
      ? `Nothing in the library is ${Model.typeLabel(draftObs.type).toLowerCase()} yet.`
      : anyTags
        ? `${plural(pool, 'species')} on file, ranked against ${plural(tagCount, 'tag')}.`
        : `${plural(pool, 'species')} on file. Add tags above to narrow this down.`;

    clear(candList);
    // A species the tags rule out still stands to be chosen: the contradiction
    // is usually right, but it can also mean the specimen was misread. Hiding
    // the answer would help nobody.
    for (const match of rows) candList.append(candidateRow(match));

    if (!rows.length) {
      candList.append(el('div', 'empty-state', 'No species of this type on file yet.'));
    }
    candList.append(writeUpButton());
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
    if (sp.scientificName) body.append(el('p', 'candidate-sci sci', sp.scientificName));

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

  /** Nothing in the library fits — write the species up from these very tags. */
  function writeUpButton() {
    const wrap = el('div', 'candidate-writeup');
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
      footerText.append(
        el('span', 'field-label', 'Chosen'),
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
      state.mapSelection = null;
      close({ force: true });
      render();
    }
  }

  // An existing identification can be taken back off without picking another.
  if (row.identified) {
    const clear_ = el('button', 'ghost-button is-danger', 'Clear identification');
    clear_.type = 'button';
    clear_.addEventListener('click', () => commit({ speciesId: null, confidence: 'high' }));
    footer.insertBefore(clear_, saveTags);
  }

  redraw();
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
    division: '', nutrition: 'unknown', characters: {}, formerNames: [], photos: [],
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
    field('Nutrition', nutritionPick, { hint: 'How it feeds.' }),
  );
  traits.append(traitRow);

  traits.append(el('p', 'character-note',
    'Type a tag and press Enter. No tags means not recorded; tick N/A when the species genuinely has no such structure. Tags colour themselves by what they are — click one to reclassify it.'));

  const grid = el('div', 'characters');
  const characterFields = Model.FUNGI_CHARACTERS.map((spec) => {
    const cell = tagField(spec, Model.character(record, spec.id), markDirty);
    grid.append(cell.node);
    return cell;
  });
  traits.append(grid);

  const former = formerNamesEditor(record.formerNames || []);
  const formerWrap = el('div');
  formerWrap.append(el('span', 'field-label', 'Former scientific names'), former.node);
  formerWrap.style.marginTop = '10px';
  traits.append(formerWrap);

  const syncKind = () => { traits.hidden = kindPick.value !== 'fungi'; };
  kindPick.addEventListener('change', syncKind);
  syncKind();
  form.append(traits);

  const editor = sheetSection(sheet, creating ? 'New species' : 'The species');
  editor.append(form);

  // --- example photographs
  const tray = makeTray({ existing: record.photos || [], onChange: markDirty, note: 'Reference shots — what a good one looks like.' });
  sheetSection(sheet, 'Example photographs', 'Kept on the species, separate from any one find.').append(tray.node);

  // --- finds of this species
  if (!creating) {
    const mine = Model.sortByDate(Model.viewAll(state.observations, state.species).filter((r) => r.species?.id === record.id));
    const section = sheetSection(sheet, 'Finds', mine.length ? `${plural(mine.length, 'observation')} of this species.` : null);
    if (!mine.length) {
      section.append(el('div', 'empty-state', 'Written up, but not yet met in the field.'));
    } else {
      const gallery = el('div', 'gallery');
      for (const row of mine) gallery.append(findCard(row));
      section.append(gallery);
    }
  }

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
function tagChip(tag, { onCycle, onRemove } = {}) {
  const chip = el('span', 'tag');
  chip.dataset.category = tag.category;

  if (tag.category === 'colour') {
    const swatch = el('span', 'tag-swatch');
    const paint = Model.tagSwatch(tag.text);
    if (paint) swatch.style.background = paint;
    chip.append(swatch);
  }

  if (onCycle) {
    const label = el('button', 'tag-text', tag.text);
    label.type = 'button';
    label.title = `${Model.tagCategory(tag.category).label} — click to reclassify`;
    label.addEventListener('click', onCycle);
    chip.append(label);
  } else {
    chip.append(el('span', 'tag-text', tag.text));
  }

  if (onRemove) {
    const drop = el('button', 'tag-drop', '×');
    drop.type = 'button';
    drop.setAttribute('aria-label', `Remove ${tag.text}`);
    drop.addEventListener('click', onRemove);
    chip.append(drop);
  }
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

  // A native datalist rather than a bespoke menu: it is one element, it works
  // with the keyboard, and on a phone it is the platform's own picker.
  const listId = `vocab-${spec.id}-${uid()}`;
  const suggestions = el('datalist');
  suggestions.id = listId;
  for (const word of Model.characterVocab(spec)) suggestions.append(new Option(word));

  const box = input('text', '', { placeholder: 'Add a tag…', list: listId, autocomplete: 'off' });

  const changed = () => { draw(); onChange?.(); };

  const removeAt = (i) => { tags.splice(i, 1); changed(); };
  const cycle = (tag) => {
    const ids = Model.TAG_CATEGORIES.map((c) => c.id);
    tag.category = ids[(ids.indexOf(tag.category) + 1) % ids.length];
    changed();
  };

  function draw() {
    clear(list);
    tags.forEach((tag, i) => {
      list.append(tagChip(tag, { onCycle: () => cycle(tag), onRemove: () => removeAt(i) }));
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

  const sync = () => {
    cell.classList.toggle('is-na', naBox.checked);
    list.hidden = naBox.checked;
    absentLine.hidden = !naBox.checked;
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
function formerNamesEditor(initial) {
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

  const box = input('text', '', { placeholder: 'A name it used to go by' });
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
  window.addEventListener('popstate', () => setView(viewFromUrl(), { push: false }));

  obsTray = makeTray({
    zone: $('obs-drop'),
    fileInput: $('obs-file'),
    strip: $('obs-shots'),
    onChange: () => { adoptMetadata(obsTray.photos()); syncObsForm(); },
  });

  $('obs-form').addEventListener('submit', submitObservation);
  $('obs-reset').addEventListener('click', () => { resetObsForm(); notice(''); });

  $('filter-q').addEventListener('input', (ev) => { state.filters.q = ev.target.value; renderGallery(derive().rows); });
  $('filter-sp-q').addEventListener('input', (ev) => { state.speciesFilters.q = ev.target.value; renderSpeciesTable(derive().life); });
  $('species-new').addEventListener('click', () => openSpeciesSheet(null, {}));
  $('map-species').addEventListener('change', (ev) => {
    state.mapFilters.speciesId = ev.target.value;
    state.mapSelection = null;
    // A species that was matched against iNaturalist can narrow the overlay to
    // that taxon — everyone else's finds of the same thing, nearby.
    if (state.mapFilters.showInat) loadInat();
    render();
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
    resizeTimer = setTimeout(() => { if (state.view === 'log') renderSeason(derive().rows); }, 150);
  });
}

async function boot() {
  try {
    const payload = await request('api/state', 'GET');
    state.config = payload.config;
    state.observations = payload.observations || [];
    state.species = payload.species || [];
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
