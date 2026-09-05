// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: camera-retro;

/* ---------------------------------------------------------------------------
 * Field Notes — one of your own finds, on the home screen.
 *
 * A photograph you took, what it was, and when. Tapping opens that find in the
 * browser — the same link the app writes into the address bar when the find's
 * sheet is open, so what the widget points at and what you could copy out of a
 * tab are one string.
 *
 * The server picks (`/api/widget/find`), for the reason a widget cannot: it
 * wakes on the system's schedule, remembers nothing, and is on the metered end
 * of the connection.
 *
 * Install: copy into Scriptable, add a widget, choose this script, and put the
 * address of your log — "http://192.168.0.60:4175" — in the Parameter field.
 * ------------------------------------------------------------------------- */

const FALLBACK_BASE = 'https://batcave.tail9f2885.ts.net/tracker/';
const REFRESH_MINUTES = 30;

const BASE = (args.widgetParameter || FALLBACK_BASE).trim().replace(/\/+$/, '');
const at = (rel) => `${BASE}/${String(rel).replace(/^\//, '')}`;

const INK = new Color('#f4f4f6');
const INK_SOFT = new Color('#a2a2ad');
const INK_FAINT = new Color('#6b6b76');
const PAPER = new Color('#0a0a0b');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The log stores local wall time with no zone — "2024-10-15T13:25" — because
 * a find happened where you were standing. Parsing it as a Date would have the
 * phone read it as UTC and shift the date by a day near midnight, so the
 * string is read rather than parsed.
 */
function fmtDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

async function build() {
  let payload;
  try {
    payload = await new Request(at('api/widget/find')).loadJSON();
  } catch (err) {
    return message('Field Notes', `Could not reach ${BASE}\n${err.message}`);
  }
  if (payload.empty) return message('Field Notes', 'No find in the log carries a photograph yet.');

  const widget = new ListWidget();
  widget.url = at(payload.link);
  widget.backgroundColor = PAPER;
  widget.setPadding(12, 14, 12, 14);

  const shot = await loadImage(at(payload.photo));
  if (shot) widget.backgroundImage = scrimmed(shot);

  widget.addSpacer();

  // Unidentified finds say so, and a low-confidence identification keeps the
  // question mark the server put on it. A widget must not be the place where a
  // guess quietly becomes an answer.
  const name = widget.addText(payload.name);
  name.font = Font.semiboldSystemFont(15);
  name.textColor = INK;
  name.minimumScaleFactor = 0.8;
  name.lineLimit = 2;
  shadow(name);

  const facts = [fmtDate(payload.when), payload.place].filter(Boolean).join(' · ');
  if (facts) {
    const line = widget.addText(facts);
    line.font = Font.systemFont(11);
    line.textColor = INK_SOFT;
    line.lineLimit = 1;
    shadow(line);
  }

  if (payload.credit && config.widgetFamily !== 'small') {
    const credit = widget.addText(payload.credit);
    credit.font = Font.systemFont(8);
    credit.textColor = INK_FAINT;
    credit.lineLimit = 1;
    shadow(credit);
  }

  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
  return widget;
}

/** A photograph, with its lower half darkened so text can sit on it. */
function scrimmed(image) {
  const size = canvasSize();
  const draw = new DrawContext();
  draw.size = size;
  draw.opaque = false;
  draw.respectScreenScale = true;

  const scale = Math.max(size.width / image.size.width, size.height / image.size.height);
  const w = image.size.width * scale;
  const h = image.size.height * scale;
  draw.drawImageInRect(image, new Rect((size.width - w) / 2, (size.height - h) / 2, w, h));

  // No gradient primitive here, so: bands. Squared rather than linear, which
  // puts the change where the eye is least likely to find an edge in it — the
  // top of the scrim fades in from nothing, and the darkness gathers under the
  // words. Twenty bands striped visibly on a bright photograph; these do not.
  const bands = 64;
  const from = size.height * 0.42;
  const step = (size.height - from) / bands;
  for (let i = 0; i < bands; i++) {
    const depth = (i + 1) / bands;
    draw.setFillColor(new Color('#000000', 0.78 * depth * depth));
    draw.fillRect(new Rect(0, from + step * i, size.width, step + 1));
  }
  return draw.getImage();
}

function canvasSize() {
  const family = config.widgetFamily || 'medium';
  if (family === 'small') return new Size(170, 170);
  if (family === 'large') return new Size(364, 382);
  if (family === 'extraLarge') return new Size(762, 382);
  return new Size(364, 170);
}

async function loadImage(url) {
  try {
    return await new Request(url).loadImage();
  } catch {
    return null;
  }
}

function shadow(text) {
  text.shadowColor = new Color('#000000', 0.8);
  text.shadowRadius = 4;
  text.shadowOffset = new Point(0, 1);
}

function message(title, body) {
  const widget = new ListWidget();
  widget.backgroundColor = PAPER;
  widget.setPadding(14, 14, 14, 14);
  const head = widget.addText(title);
  head.font = Font.semiboldSystemFont(13);
  head.textColor = INK;
  widget.addSpacer(6);
  const note = widget.addText(body);
  note.font = Font.systemFont(11);
  note.textColor = INK_SOFT;
  widget.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
  return widget;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else if (config.widgetFamily === 'small') widget.presentSmall();
else if (config.widgetFamily === 'large') widget.presentLarge();
else widget.presentMedium();
Script.complete();
