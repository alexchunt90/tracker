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
  function create({ node, tileUrl, attribution, minZoom = 2, maxZoom = 19, onSelect, onViewChange }) {
    const view = { lat: 0, lon: 0, zoom: 2 };
    let pins = [];
    // Tiles that 404 or time out. Remembered so a dead basemap is not re-asked
    // for on every single pan.
    const failed = new Set();

    node.classList.add('map');
    node.innerHTML = '';

    const tileLayer = document.createElement('div');
    tileLayer.className = 'map-tiles';
    const pinLayer = document.createElement('div');
    pinLayer.className = 'map-pins';
    node.append(tileLayer, pinLayer);

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

    function drawPins() {
      const { x: ox, y: oy, w, h } = origin();
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
        marker.style.left = `${left}px`;
        marker.style.top = `${top}px`;
        marker.title = pin.label;
        marker.setAttribute('aria-label', pin.label);
        if (pin.dangerous) marker.classList.add('is-dangerous');
        if (pin.choice) marker.classList.add('is-choice');
        marker.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onSelect?.(pin);
        });
        pinLayer.append(marker);
      }
    }

    const draw = () => { drawTiles(); drawPins(); };

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
    node.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.map-controls, .map-pin')) return;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false };
      node.setPointerCapture(ev.pointerId);
      node.classList.add('is-dragging');
    });
    node.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!dx && !dy) return;
      drag.moved = true;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      const { x, y, w, h } = origin();
      // Panning is a redraw at a shifted origin, not a transform: at these tile
      // counts it is cheap, and it keeps one code path for where things are.
      const centre = unproject(x - dx + w / 2, y - dy + h / 2, view.zoom);
      view.lat = clamp(centre.lat, -MAX_LAT, MAX_LAT);
      view.lon = centre.lon;
      draw();
    });
    const endDrag = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      node.classList.remove('is-dragging');
      // Only tell the caller once the hand comes off, or a pan would fire a
      // network request per frame.
      if (moved) onViewChange?.(bounds());
    };
    node.addEventListener('pointerup', endDrag);
    node.addEventListener('pointercancel', endDrag);

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
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(draw, 120); };
    window.addEventListener('resize', onResize);

    return {
      setPins(next, { refit = false } = {}) {
        pins = next || [];
        if (refit) fit(); else drawPins();
      },
      setView,
      bounds,
      fit,
      redraw: draw,
      destroy() { window.removeEventListener('resize', onResize); node.innerHTML = ''; },
    };
  }

  return { create, project, unproject, fitBounds };
})();

if (typeof module !== 'undefined') module.exports = MapView;
