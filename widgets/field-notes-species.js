// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: seedling;

/* ---------------------------------------------------------------------------
 * Field Notes — a species from the library, on the home screen.
 *
 * One example photograph, the name under it, and a tap that opens that species
 * in the browser. The picking happens on the server (`/api/widget/species`):
 * a widget wakes on the system's schedule with no memory of the last time it
 * drew, so choosing here would mean pulling the whole library down the phone's
 * connection to throw all but one of it away.
 *
 * Install: copy into Scriptable, add a widget, choose this script, and put the
 * address of your log — "http://192.168.0.60:4175" — in the Parameter field.
 * ------------------------------------------------------------------------- */

// Used when the widget has no Parameter set, and when running the script by
// hand in the Scriptable app.
const FALLBACK_BASE = 'https://batcave.tail9f2885.ts.net/tracker/';

// The log changes at the pace of a walk in the woods, not a share price.
const REFRESH_MINUTES = 30;

const BASE = (args.widgetParameter || FALLBACK_BASE).trim().replace(/\/+$/, '');
const at = (rel) => `${BASE}/${String(rel).replace(/^\//, '')}`;

const INK = new Color('#f4f4f6');
const INK_SOFT = new Color('#a2a2ad');
const INK_FAINT = new Color('#6b6b76');
const PAPER = new Color('#0a0a0b');

async function build() {
  let payload;
  try {
    payload = await new Request(at('api/widget/species')).loadJSON();
  } catch (err) {
    return message('Field Notes', `Could not reach ${BASE}\n${err.message}`);
  }
  if (payload.empty) return message('Field Notes', 'No species in the library carries a photograph yet.');

  const widget = new ListWidget();
  // The whole tile is the tap target, and this is the link the app itself
  // writes into the address bar when this species is open.
  widget.url = at(payload.link);
  widget.backgroundColor = PAPER;
  widget.setPadding(12, 14, 12, 14);

  const shot = await loadImage(at(payload.photo));
  if (shot) widget.backgroundImage = scrimmed(shot);

  // Everything sits at the bottom, over the darkened part of the photograph.
  widget.addSpacer();

  const name = widget.addText(payload.name);
  name.font = Font.semiboldSystemFont(15);
  name.textColor = INK;
  name.minimumScaleFactor = 0.8;
  name.lineLimit = 2;
  shadow(name);

  if (payload.scientificName && payload.scientificName !== payload.name) {
    const sci = widget.addText(payload.scientificName);
    sci.font = Font.italicSystemFont(11);
    sci.textColor = INK_SOFT;
    sci.lineLimit = 1;
    shadow(sci);
  }

  // Somebody else's photograph carries a licence that asks to be credited, and
  // a home screen is as public a place as the app is. The small widget has no
  // room for it, so it does not borrow one that needs it.
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

  // Aspect fill: a widget is a fixed rectangle and a photograph is not, and
  // letterboxing a picture on a home screen looks like a mistake.
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

/** The drawing area, in points, for the family the widget was added at. */
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
    // An unreachable photograph is not a broken widget: the caption still says
    // what the species is, on the plain ground.
    return null;
  }
}

function shadow(text) {
  text.shadowColor = new Color('#000000', 0.8);
  text.shadowRadius = 4;
  text.shadowOffset = new Point(0, 1);
}

/** Something went wrong, said in the widget rather than as a red error card. */
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
