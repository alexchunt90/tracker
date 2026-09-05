/* ==========================================================================
   A slippy map, in about three hundred lines and no dependency.

   Leaflet would be the obvious answer and it is a good library. It is also a
   network dependency in an app whose whole point is to work in a forest, and
   this app needs four things from a map: draw tiles, pan, zoom, and put dots
   in the right places. That is Web Mercator and some arithmetic.

   Tiles come from this app's own server, which caches them to disk — so ground
   you have already looked at still draws with no signal, and no third party
   gets handed a log of where you have been looking.
   ========================================================================== */

'use strict';

const MapView = (() => {
  const TILE = 256;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Web Mercator cannot represent the poles: tan(±90°) is infinite. This is
  // the latitude the projection is conventionally cut off at, and it is what
  // makes the world square.
  const MAX_LAT = 85.0511287798;

  /** Geographic to world pixels at a given zoom. */
  function project(lat, lon, zoom) {
    const scale = TILE * 2 ** zoom;
    const clamped = clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180;
    return {
      x: ((lon + 180) / 360) * scale,
      y: ((1 - Math.log(Math.tan(clamped) + 1 / Math.cos(clamped)) / Math.PI) / 2) * scale,
    };
  }

  /** World pixels back to geographic. */
  function unproject(x, y, zoom) {
    const scale = TILE * 2 ** zoom;
    const n = Math.PI - (2 * Math.PI * y) / scale;
    return {
      lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
      lon: (x / scale) * 360 - 180,
    };
  }

  /**
   * The zoom at which a bounding box fits a viewport, and its centre.
   * Returns null for an empty set — the caller then falls back to a
   * configured default rather than pointing the map at the Gulf of Guinea.
   */
  function fitBounds(points, width, height, { maxZoom = 17, padding = 0.82 } = {}) {
    if (!points.length) return null;
    const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const centre = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };

    // A single point — or several at the same spot — has no extent to fit, so
    // there is nothing to solve for and any zoom is "correct". Pick a close one.
    if (maxLat - minLat < 1e-9 && maxLon - minLon < 1e-9) return { ...centre, zoom: Math.min(15, maxZoom) };

    for (let zoom = maxZoom; zoom >= 0; zoom--) {
      const a = project(minLat, minLon, zoom);
      const b = project(maxLat, maxLon, zoom);
      if (Math.abs(b.x - a.x) <= width * padding && Math.abs(b.y - a.y) <= height * padding) {
        return { ...centre, zoom };
      }
    }
    return { ...centre, zoom: 0 };
  }

  /**
   * Build a map into `node`.
   *
   * The caller owns the pins and hands over a fresh list whenever they change;
   * the map owns the viewport. Keeping those apart is what lets a filter redraw
   * the pins without throwing away where you had panned to.
   */
  const SVG = 'http://www.w3.org/2000/svg';

  /**
   * Shape says whose record it is, colour and fill say how edible: a circle
   * for your own find, a triangle for somebody else's.
   *
   * SVG rather than a CSS border, because half the edibility tiers are
   * hollow and a CSS triangle is a border trick with no interior to leave
   * empty \u2014 it can only ever be solid.
   */
  function pinShape(kind) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    let shape;
    if (kind === 'inat') {
      shape = document.createElementNS(SVG, 'polygon');
      shape.setAttribute('points', '10,3.5 17.5,16.5 2.5,16.5');
    } else {
      shape = document.createElementNS(SVG, 'circle');
      shape.setAttribute('cx', '10');
      shape.setAttribute('cy', '10');
      shape.setAttribute('r', '6.8');
    }
    svg.append(shape);
    return svg;
  }

  function create({ node, tileUrl, attribution, minZoom = 2, maxZoom = 19, onSelect, onViewChange, onHover, onRainToggle, onRecentToggle }) {
    const view = { lat: 0, lon: 0, zoom: 2 };
    let pins = [];
    // The rainfall overlay: cells on a fixed geographic lattice, each already
    // carrying the colour the caller wants it drawn in. The map places them and
    // says nothing about what they mean.
    let rain = { cells: [], spacing: 0 };
    // Tiles that 404 or time out. Remembered so a dead basemap is not re-asked
    // for on every single pan.
    const failed = new Set();

    node.classList.add('map');
    node.innerHTML = '';

    const tileLayer = document.createElement('div');
    tileLayer.className = 'map-tiles';
    // Between the basemap and the pins on purpose: it is ground information,
    // so it belongs under the pins the way the terrain does, not over them.
    const rainLayer = document.createElement('div');
    rainLayer.className = 'map-rain';
    rainLayer.hidden = true;
    const pinLayer = document.createElement('div');
    pinLayer.className = 'map-pins';
    node.append(tileLayer, rainLayer, pinLayer);

    const controls = document.createElement('div');
    controls.className = 'map-controls';
    const button = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'map-button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', onClick);
      return b;
    };
    controls.append(
      button('+', 'Zoom in', () => zoomBy(1)),
      button('−', 'Zoom out', () => zoomBy(-1)),
      button('⤢', 'Fit to pins', () => fit()),
    );

    // Only offered when the caller has somewhere to send the answer. A map
    // built without an onRainToggle simply has no rain button.
    let rainButton = null;
    if (onRainToggle) {
      rainButton = button('☂', 'Recent rainfall', () => onRainToggle());
      rainButton.classList.add('map-button-toggle');
      rainButton.setAttribute('aria-pressed', 'false');
      controls.append(rainButton);
    }

    // Under the rain, because it asks the same question of a different layer:
    // never mind the whole record, what has been happening lately.
    let recentButton = null;
    if (onRecentToggle) {
      recentButton = button('◷', 'Only iNaturalist finds from the past month', () => onRecentToggle());
      recentButton.classList.add('map-button-toggle');
      recentButton.setAttribute('aria-pressed', 'false');
      controls.append(recentButton);
    }
    node.append(controls);

    const credit = document.createElement('div');
    credit.className = 'map-credit';
    credit.textContent = attribution || '';
    node.append(credit);

    const note = document.createElement('div');
    note.className = 'map-note';
    note.hidden = true;
    node.append(note);

    const size = () => ({ w: node.clientWidth || 640, h: node.clientHeight || 420 });

    /** Top-left of the viewport, in world pixels. */
    function origin() {
      const { w, h } = size();
      const centre = project(view.lat, view.lon, view.zoom);
      return { x: centre.x - w / 2, y: centre.y - h / 2, w, h };
    }

    // --- drawing ------------------------------------------------------------

    function drawTiles() {
      const { x: ox, y: oy, w, h } = origin();
      const span = 2 ** view.zoom;
      const keep = new Map();

      const x0 = Math.floor(ox / TILE), x1 = Math.floor((ox + w) / TILE);
      const y0 = Math.floor(oy / TILE), y1 = Math.floor((oy + h) / TILE);

      for (let ty = y0; ty <= y1; ty++) {
        // There is no map above the north pole or below the south one; x wraps
        // around the globe, y does not.
        if (ty < 0 || ty >= span) continue;
        for (let tx = x0; tx <= x1; tx++) {
          const wrapped = ((tx % span) + span) % span;
          const key = `${view.zoom}/${wrapped}/${ty}`;
          keep.set(`${tx}:${ty}`, { key, wrapped, ty, left: tx * TILE - ox, top: ty * TILE - oy });
        }
      }

      tileLayer.innerHTML = '';
      for (const t of keep.values()) {
        const img = document.createElement('img');
        img.className = 'map-tile';
        img.style.left = `${t.left}px`;
        img.style.top = `${t.top}px`;
        img.width = TILE;
        img.height = TILE;
        img.alt = '';
        img.draggable = false;
        if (failed.has(t.key)) {
          img.classList.add('is-missing');
        } else {
          img.addEventListener('error', () => {
            failed.add(t.key);
            img.classList.add('is-missing');
            reportBasemap();
          }, { once: true });
          img.src = `tiles/${t.key}.png`;
        }
        tileLayer.append(img);
      }
      reportBasemap();
    }

    /**
     * Say so when there is no basemap, rather than showing a blank rectangle.
     *
     * Counted off what is on screen right now. Running totals were the first
     * attempt and they were wrong: a long session of good tiles buries a
     * newly-failing zoom level in the ratio, and the map goes silently black
     * exactly when it most needs to explain itself.
     */
    function reportBasemap() {
      const total = tileLayer.childElementCount;
      const missing = tileLayer.querySelectorAll('.map-tile.is-missing').length;
      const bare = total > 0 && missing >= total * 0.8;
      node.classList.toggle('is-bare', bare);
      note.hidden = !bare;
      if (bare) note.textContent = 'No basemap here — offline, or the tile server is unreachable. Pins are still placed correctly.';
    }

    /**
     * The rainfall overlay: one rectangle per lattice cell, blurred into a field.
     *
     * The blur is the point. A grid of hard-edged squares reads as data the
     * model does not have — it implies the rain stopped at 47.65° — whereas a
     * soft field reads as what it is, which is an estimate over an area. It is
     * also honest about the resolution: the smear is about as wide as one cell,
     * so the picture cannot be over-read.
     */
    function drawRain() {
      rainLayer.hidden = !rain.cells.length;
      rainLayer.innerHTML = '';
      if (!rain.cells.length) return;

      const { x: ox, y: oy, w, h } = origin();
      const half = rain.spacing / 2;

      // Cell width is constant at a zoom; height is not, because Mercator
      // stretches as it goes north. Measuring one cell gives both, and the
      // width is the same for all of them.
      const sample = rain.cells[0];
      const west = project(sample.lat, sample.lon - half, view.zoom);
      const east = project(sample.lat, sample.lon + half, view.zoom);
      const cellW = Math.abs(east.x - west.x);

      // A blur wide enough to join neighbouring cells but not to wash the field
      // flat. Below a couple of pixels it stops reading as a gradient at all.
      rainLayer.style.setProperty('--rain-blur', `${Math.max(2, cellW * 0.45).toFixed(1)}px`);

      for (const cell of rain.cells) {
        const top = project(cell.lat + half, cell.lon, view.zoom);
        const bottom = project(cell.lat - half, cell.lon, view.zoom);
        const cellH = Math.abs(bottom.y - top.y);
        const left = project(cell.lat, cell.lon - half, view.zoom).x - ox;
        const y = top.y - oy;

        // The blur reaches beyond the cell, so a cell just off-screen still
        // colours the edge of the viewport. Culling at the exact bounds would
        // leave a visible seam there.
        if (left < -cellW * 3 || y < -cellH * 3 || left > w + cellW * 2 || y > h + cellH * 2) continue;

        const box = document.createElement('div');
        box.className = 'map-rain-cell';
        box.style.left = `${left}px`;
        box.style.top = `${y}px`;
        // Overlapped by a hair, so the seams between cells do not show through
        // as a lighter grid once the blur has softened everything else.
        box.style.width = `${cellW + 1}px`;
        box.style.height = `${cellH + 1}px`;
        box.style.background = cell.colour;
        rainLayer.append(box);
      }
    }

    function drawPins() {
      const { x: ox, y: oy, w, h } = origin();
      // Panning rebuilds every marker, so a hover left open would point at an
      // element that is no longer in the document.
      onHover?.(null);
      pinLayer.innerHTML = '';

      // Draw the user's own pins last so they sit above the crowd-sourced ones
      // where they overlap. Whose record it is matters more than which is newer.
      const ordered = [...pins].sort((a, b) => (a.kind === 'mine' ? 1 : 0) - (b.kind === 'mine' ? 1 : 0));

      for (const pin of ordered) {
        const p = project(pin.lat, pin.lon, view.zoom);
        const left = p.x - ox, top = p.y - oy;
        // A generous margin: a pin just off-screen still has its head visible.
        if (left < -40 || top < -40 || left > w + 40 || top > h + 40) continue;

        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = `map-pin is-${pin.kind}`;
        marker.dataset.type = pin.type;
        // Only set when the caller has an edibility to say; without it the pin
        // falls back to its type colour rather than claiming "not recorded".
        if (pin.edibility) marker.dataset.edibility = pin.edibility;
        if (pin.opacity != null) marker.style.opacity = String(pin.opacity);
        marker.style.left = `${left}px`;
        marker.style.top = `${top}px`;
        // No `title`: the caller shows a richer hover of its own, and the
        // browser's native tooltip fires on a similar delay and lands on top
        // of it. The label survives as the accessible name.
        marker.setAttribute('aria-label', pin.label);
        marker.append(pinShape(pin.kind));
        marker.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onHover?.(null);
          onSelect?.(pin);
        });
        if (onHover) {
          marker.addEventListener('mouseenter', () => onHover(pin, marker));
          marker.addEventListener('mouseleave', () => onHover(null));
        }
        pinLayer.append(marker);
      }
    }

    const draw = () => { drawTiles(); drawRain(); drawPins(); };

    // --- viewport -----------------------------------------------------------

    function setView(next, { silent = false } = {}) {
      view.lat = clamp(next.lat, -MAX_LAT, MAX_LAT);
      view.lon = ((((next.lon + 180) % 360) + 360) % 360) - 180;
      view.zoom = clamp(Math.round(next.zoom), minZoom, maxZoom);
      draw();
      if (!silent) onViewChange?.(bounds());
    }

    /** The geographic box currently on screen. */
    function bounds() {
      const { x, y, w, h } = origin();
      const sw = unproject(x, y + h, view.zoom);
      const ne = unproject(x + w, y, view.zoom);
      return { swlat: sw.lat, swlng: sw.lon, nelat: ne.lat, nelng: ne.lon, zoom: view.zoom };
    }

    function zoomBy(delta, anchor) {
      const next = clamp(view.zoom + delta, minZoom, maxZoom);
      if (next === view.zoom) return;
      if (!anchor) { setView({ ...view, zoom: next }); return; }

      // Zoom about the pointer: whatever was under the cursor stays under it.
      const { x: ox, y: oy, w, h } = origin();
      const held = unproject(ox + anchor.x, oy + anchor.y, view.zoom);
      const p = project(held.lat, held.lon, next);
      const centre = unproject(p.x - anchor.x + w / 2, p.y - anchor.y + h / 2, next);
      setView({ ...centre, zoom: next });
    }

    function fit() {
      const placed = pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      const { w, h } = size();
      const found = fitBounds(placed, w, h, { maxZoom });
      if (found) setView(found);
    }

    // --- interaction --------------------------------------------------------

    let drag = null;
    let pinch = null;
    // Every finger currently down, so a second one can turn a pan into a pinch
    // and lifting it can turn it back.
    const down = new Map();

    /** Shift the view by a screen-space delta. */
    function panBy(dx, dy) {
      if (!dx && !dy) return;
      const { x, y, w, h } = origin();
      // Panning is a redraw at a shifted origin, not a transform: at these tile
      // counts it is cheap, and it keeps one code path for where things are.
      const centre = unproject(x - dx + w / 2, y - dy + h / 2, view.zoom);
      view.lat = clamp(centre.lat, -MAX_LAT, MAX_LAT);
      view.lon = centre.lon;
      draw();
    }

    const spread = () => {
      const [a, b] = [...down.values()];
      return {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        // In the map's own coordinates, because that is what zoomBy anchors on.
        mid: (() => {
          const box = node.getBoundingClientRect();
          return { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top };
        })(),
      };
    };

    /*
     * Two fingers: zoom about the point between them, and pan with it.
     *
     * Zoom here is whole levels — the tiles are — so the gesture is measured
     * rather than applied continuously: doubling the distance between the
     * fingers is one level, and `Math.round` means the level turns over when
     * they are halfway there in log space. Counting from the distance the
     * gesture *started* at, rather than stepping on each threshold crossing,
     * is what makes pinching out and back in again land where it began.
     */
    function startPinch() {
      if (down.size !== 2) return;
      drag = null;
      node.classList.remove('is-dragging');
      const { dist, mid } = spread();
      pinch = { dist, mid, applied: 0, zoomed: false };
    }

    function movePinch() {
      if (!pinch || down.size !== 2) return;
      const { dist, mid } = spread();
      panBy(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
      pinch.mid = mid;
      if (pinch.dist > 0 && dist > 0) {
        const want = Math.round(Math.log2(dist / pinch.dist));
        if (want !== pinch.applied) {
          zoomBy(want - pinch.applied, mid);
          pinch.applied = want;
          pinch.zoomed = true;
        }
      }
    }

    node.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.map-controls')) return;
      /*
       * Every finger is captured, not just the first.
       *
       * Without it, a touch that ends somewhere other than the map — sliding
       * off the edge, a gesture the browser takes over — never delivers its
       * pointerup here, and the entry sits in `down` forever. One stale finger
       * makes the map think two are still on it, and pinch and pan both wedge
       * until the page is reloaded.
       */
      try { node.setPointerCapture(ev.pointerId); } catch { /* already gone */ }
      down.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (down.size === 2) { startPinch(); return; }
      if (down.size > 2 || ev.target.closest('.map-pin')) return;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false };
      node.classList.add('is-dragging');
    });

    node.addEventListener('pointermove', (ev) => {
      if (down.has(ev.pointerId)) down.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch) { movePinch(); return; }
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!dx && !dy) return;
      drag.moved = true;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      panBy(dx, dy);
    });

    const endDrag = (ev) => {
      const wasPinching = !!pinch;
      if (down.delete(ev.pointerId) && pinch && down.size < 2) {
        pinch = null;
        // One finger still down: carry on panning from where it is rather than
        // making the hand come off and start again.
        const [id] = [...down.keys()];
        if (id !== undefined) {
          const p = down.get(id);
          drag = { id, x: p.x, y: p.y, moved: false };
          node.classList.add('is-dragging');
        }
      }
      if (drag && ev.pointerId === drag.id) {
        const moved = drag.moved;
        drag = null;
        node.classList.remove('is-dragging');
        if (moved) onViewChange?.(bounds());
        return;
      }
      // A pinch that ends with both fingers lifting still changed the view.
      if (wasPinching && !pinch && !down.size) onViewChange?.(bounds());
    };
    node.addEventListener('pointerup', endDrag);
    node.addEventListener('pointercancel', endDrag);
    // The capture ending is the last word on a pointer, whatever else was or
    // was not delivered. Belt and braces, because a wedged map is unusable and
    // the cost of an extra cleanup is nothing.
    node.addEventListener('lostpointercapture', endDrag);

    /**
     * Wheel zoom, paid for by the distance scrolled and capped by the clock.
     *
     * A level per wheel event was the first attempt, and it is unusable on
     * anything but an old notched mouse: a trackpad flick fires dozens of small
     * deltas, and the map crosses the whole zoom range before your fingers have
     * left the glass. Only the extremes are reachable, which is the one thing a
     * zoom must not do.
     *
     * So the deltas are banked, and a level is spent when the bank fills — a
     * notch on a wheel is one level, a swipe is worth the distance it actually
     * travelled. Two limits keep that honest. The bank never holds more than a
     * level, or the tail of a momentum scroll — which goes on arriving well
     * after the hand has stopped — would dribble out zoom for a second
     * afterwards. And levels are spaced by a cooldown, which is what puts a
     * ceiling on how fast the view can get away from you no matter how hard the
     * gesture was thrown.
     */
    const ZOOM_STEP_PX = 100;    // scroll distance that buys one zoom level
    const PINCH_STEP_PX = 40;    // a pinch reports smaller, more deliberate deltas
    const ZOOM_COOLDOWN = 150;   // ms between levels
    const GESTURE_IDLE = 400;    // ms of quiet that ends a gesture and empties the bank

    // deltaY is in pixels, lines, or pages depending on the device. The line and
    // page sizes are the conventional ones: three lines is one notch of a wheel.
    const LINE_PX = 40, PAGE_PX = 400;
    function wheelPixels(ev) {
      if (ev.deltaMode === 1) return ev.deltaY * LINE_PX;
      if (ev.deltaMode === 2) return ev.deltaY * PAGE_PX;
      return ev.deltaY;
    }

    let bank = 0, wheelAt = 0, zoomedAt = 0;
    node.addEventListener('wheel', (ev) => {
      ev.preventDefault();

      const now = ev.timeStamp || performance.now();
      if (now - wheelAt > GESTURE_IDLE) bank = 0;
      wheelAt = now;

      // macOS reports a trackpad pinch as a wheel event with ctrlKey set.
      const step = ev.ctrlKey ? PINCH_STEP_PX : ZOOM_STEP_PX;
      const delta = wheelPixels(ev);
      // Turning back the other way should answer at once, not spend a notch
      // undoing what the bank was holding.
      if (delta * bank < 0) bank = 0;
      bank = clamp(bank + delta, -step, step);

      if (Math.abs(bank) < step) return;
      if (now - zoomedAt < ZOOM_COOLDOWN) return;
      zoomedAt = now;
      const direction = bank < 0 ? 1 : -1;  // scrolling up zooms in
      bank = 0;

      const box = node.getBoundingClientRect();
      zoomBy(direction, { x: ev.clientX - box.left, y: ev.clientY - box.top });
    }, { passive: false });

    node.addEventListener('dblclick', (ev) => {
      const box = node.getBoundingClientRect();
      zoomBy(1, { x: ev.clientX - box.left, y: ev.clientY - box.top });
    });

    // Keyboard panning, so the map is not mouse-only.
    node.tabIndex = 0;
    node.addEventListener('keydown', (ev) => {
      const step = { ArrowLeft: [-60, 0], ArrowRight: [60, 0], ArrowUp: [0, -60], ArrowDown: [0, 60] }[ev.key];
      if (step) {
        ev.preventDefault();
        const { x, y, w, h } = origin();
        setView({ ...unproject(x + step[0] + w / 2, y + step[1] + h / 2, view.zoom), zoom: view.zoom });
      } else if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomBy(1); }
      else if (ev.key === '-') { ev.preventDefault(); zoomBy(-1); }
    });

    let resizeTimer = null;
    /*
     * A resize changes what is on screen as surely as a pan does, so it has to
     * be reported the same way. Redrawing alone was enough while the only
     * things keyed to the viewport were pins the caller already had; a layer
     * fetched per bounding box goes stale instead, and a phone turned sideways
     * would keep drawing the cells it sampled for the old shape.
     */
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { draw(); onViewChange?.(bounds()); }, 120);
    };
    window.addEventListener('resize', onResize);

    return {
      setPins(next, { refit = false } = {}) {
        pins = next || [];
        if (refit) fit(); else drawPins();
      },
      /** Cells carry `{ lat, lon, colour }`; an empty list hides the layer. */
      setRain(cells, spacing) {
        rain = { cells: cells || [], spacing: spacing || 0 };
        drawRain();
      },
      /*
       * Whether the button reads as pressed. Held by the caller rather than
       * toggled here, because the layer can also be off for reasons the map
       * knows nothing about — a request still in flight, or a config that
       * switched the whole feature off.
       */
      setRainActive(on) {
        if (!rainButton) return;
        rainButton.classList.toggle('is-on', !!on);
        rainButton.setAttribute('aria-pressed', on ? 'true' : 'false');
      },
      /** The same arrangement for the recency filter: the caller holds the state. */
      setRecentActive(on) {
        if (!recentButton) return;
        recentButton.classList.toggle('is-on', !!on);
        recentButton.setAttribute('aria-pressed', on ? 'true' : 'false');
      },
      /*
       * The credit line, which changes with what is actually drawn. A layer
       * carrying an attribution requirement has to name its source while it is
       * on screen, and stop claiming it when it is not.
       */
      setCredit(text) { credit.textContent = text || ''; },
      setView,
      bounds,
      fit,
      redraw: draw,
      destroy() { window.removeEventListener('resize', onResize); node.innerHTML = ''; },
    };
  }

  return { create, project, unproject, fitBounds, pinShape };
})();

if (typeof module !== 'undefined') module.exports = MapView;
