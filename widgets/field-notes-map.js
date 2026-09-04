// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: teal; icon-glyph: map-marked-alt;

/* ---------------------------------------------------------------------------
 * Field Notes — where your finds are, on the home screen.
 *
 * The same map the app draws, drawn again with what a widget has: no DOM, no
 * Leaflet, one still image. Tiles come from the log's own `/tiles` cache, so
 * the widget asks the basemap for nothing the app has not already fetched, and
 * the pins are your own records only — the crowd-sourced ones are fetched in
 * response to what is on screen, and a home screen has no screen to respond
 * to.
 *
 * Tapping opens the map view in the browser.
 *
 * Install: copy into Scriptable, add a widget, choose this script, and put the
 * address of your log — "http://192.168.0.60:4175" — in the Parameter field.
 * ------------------------------------------------------------------------- */

const FALLBACK_BASE = 'http://192.168.0.60:4175';
const REFRESH_MINUTES = 60;

const BASE = (args.widgetParameter || FALLBACK_BASE).trim().replace(/\/+$/, '');
const at = (rel) => `${BASE}/${String(rel).replace(/^\//, '')}`;

const INK = new Color('#f4f4f6');
const INK_SOFT = new Color('#a2a2ad');
const PAPER = new Color('#0a0a0b');

const TILE = 256;
// Web Mercator cannot represent the poles: tan(±90°) is infinite. This is the
// latitude it is conventionally cut off at, and what makes the world square.
const MAX_LAT = 85.0511287798;

/*
 * The tiers, as the stylesheet draws them: choice and deadly are the filled
 * ones, each the emphatic end of its colour — the two a forager must never
 * confuse. Everything else is a ring. Kept here rather than fetched because it
 * is this widget's stylesheet; the kingdom colours, which are configurable,
 * come from the server with the pins.
 */
const EDIBILITY = {
  unknown: { colour: '#a9a9b5', fill: false },
  choice: { colour: '#4ec9a5', fill: true },
  edible: { colour: '#4ec9a5', fill: false },
  inedible: { colour: '#a2a2ad', fill: false },
  dubious: { colour: '#d8a13a', fill: false },
  toxic: { colour: '#e8705f', fill: false },
  deadly: { colour: '#e8705f', fill: true },
};

// A widget is not a map you can pan, so it is drawn to fit rather than to a
// remembered viewport — but zoomed all the way in on a single find would show
// a square of moss and nothing about where it was.
const MAX_FIT_ZOOM = 13;
// How much of the canvas the pins are asked to fit inside, so none sits on the
// very edge.
const PADDING = 0.8;

/** Geographic to world pixels at a given zoom. */
function project(lat, lon, zoom) {
  const scale = TILE * 2 ** zoom;
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
  return {
    x: ((lon + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(clamped) + 1 / Math.cos(clamped)) / Math.PI) / 2) * scale,
  };
}

/** The centre and zoom at which a set of points fits a canvas. Null if empty. */
function fitBounds(points, width, height, maxZoom) {
  if (!points.length) return null;
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const centre = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };

  // One point, or several in the same spot, has no extent to solve for.
  if (maxLat - minLat < 1e-9 && maxLon - minLon < 1e-9) return { ...centre, zoom: Math.min(13, maxZoom) };

  for (let zoom = maxZoom; zoom >= 0; zoom--) {
    const a = project(minLat, minLon, zoom);
    const b = project(maxLat, maxLon, zoom);
    if (Math.abs(b.x - a.x) <= width * PADDING && Math.abs(b.y - a.y) <= height * PADDING) {
      return { ...centre, zoom };
    }
  }
  return { ...centre, zoom: 0 };
}

async function build() {
  let payload;
  try {
    payload = await new Request(at('api/widget/map')).loadJSON();
  } catch (err) {
    return message('Field Notes', `Could not reach ${BASE}\n${err.message}`);
  }
  if (!payload.pins.length) return message('Field Notes', 'No find in the log carries a location yet.');

  const widget = new ListWidget();
  widget.url = at(payload.link);
  widget.backgroundColor = PAPER;
  widget.setPadding(0, 0, 0, 0);
  widget.backgroundImage = await drawMap(payload);
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
  return widget;
}

async function drawMap(payload) {
  const size = canvasSize();
  const fit = fitBounds(payload.pins, size.width, size.height,
    Math.min(MAX_FIT_ZOOM, payload.maxZoom ?? 19)) || payload.default;
  const centre = project(fit.lat, fit.lon, fit.zoom);
  // Top-left of the canvas, in world pixels.
  const ox = centre.x - size.width / 2;
  const oy = centre.y - size.height / 2;

  const draw = new DrawContext();
  draw.size = size;
  draw.opaque = true;
  draw.respectScreenScale = true;
  // The ground under a basemap that will not load, and the colour the app's
  // map pane is anyway.
  draw.setFillColor(new Color('#1c1c20'));
  draw.fillRect(new Rect(0, 0, size.width, size.height));

  for (const tile of await tiles(payload, fit.zoom, ox, oy, size)) {
    draw.drawImageInRect(tile.image, new Rect(tile.left, tile.top, TILE, TILE));
  }

  // Own pins only, and the same shape the app gives them: a circle, filled or
  // hollow by how edible the thing is.
  for (const pin of payload.pins) {
    const p = project(pin.lat, pin.lon, fit.zoom);
    const left = p.x - ox, top = p.y - oy;
    if (left < -20 || top < -20 || left > size.width + 20 || top > size.height + 20) continue;

    // Fungi are coloured by edibility; the other kingdoms keep their own
    // colour and stay solid, because edibility says nothing about them.
    const tier = pin.edibility ? EDIBILITY[pin.edibility] || EDIBILITY.unknown : null;
    const colour = new Color(tier ? tier.colour : payload.types[pin.type] || '#a2a2ad');
    const filled = tier ? tier.fill : true;

    // A dark ring first, standing in for the app's drop shadow: a pale pin on
    // a pale tile is otherwise invisible.
    const r = 6;
    draw.setStrokeColor(new Color('#000000', 0.55));
    draw.setLineWidth(4);
    draw.strokeEllipse(new Rect(left - r, top - r, r * 2, r * 2));

    if (filled) {
      draw.setFillColor(colour);
      draw.fillEllipse(new Rect(left - r, top - r, r * 2, r * 2));
    }
    draw.setStrokeColor(colour);
    draw.setLineWidth(2.25);
    draw.strokeEllipse(new Rect(left - r, top - r, r * 2, r * 2));
  }

  // The basemap's terms ask for its attribution wherever it is shown.
  if (payload.attribution) {
    const height = 15;
    draw.setFillColor(new Color('#0a0a0b', 0.62));
    draw.fillRect(new Rect(0, size.height - height, size.width, height));
    draw.setFont(Font.systemFont(8));
    draw.setTextColor(new Color('#c8c8d0'));
    draw.drawText(` ${payload.attribution}`, new Point(2, size.height - height + 3));
  }
  return draw.getImage();
}

/**
 * Every tile the canvas overlaps, fetched at once.
 *
 * They come from the log's own cache rather than from the tile server, which
 * is what keeps a widget refreshing four times an hour from being a stranger
 * hammering somebody else's basemap. A tile that fails is simply not drawn —
 * the pins matter more than the ground under them.
 */
async function tiles(payload, zoom, ox, oy, size) {
  if (!payload.tiles) return [];
  const span = 2 ** zoom;
  const first = Math.floor(ox / TILE), last = Math.floor((ox + size.width) / TILE);
  const top = Math.floor(oy / TILE), bottom = Math.floor((oy + size.height) / TILE);

  const wanted = [];
  for (let x = first; x <= last; x++) {
    for (let y = top; y <= bottom; y++) {
      // Off the top or bottom of the world there is no tile; round the sides
      // there is, one world over.
      if (y < 0 || y >= span) continue;
      wanted.push({ x: ((x % span) + span) % span, y, left: x * TILE - ox, top: y * TILE - oy });
    }
  }

  const loaded = await Promise.all(wanted.map(async (t) => {
    const url = at(payload.tiles.replace('{z}', zoom).replace('{x}', t.x).replace('{y}', t.y));
    try {
      return { ...t, image: await new Request(url).loadImage() };
    } catch {
      return null;
    }
  }));
  return loaded.filter(Boolean);
}

function canvasSize() {
  const family = config.widgetFamily || 'medium';
  if (family === 'small') return new Size(170, 170);
  if (family === 'large') return new Size(364, 382);
  if (family === 'extraLarge') return new Size(762, 382);
  return new Size(364, 170);
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
