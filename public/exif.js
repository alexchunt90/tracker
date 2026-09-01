/* ==========================================================================
   EXIF — enough of it to answer two questions about a photo: when, and where.

   No dependency, to match the rest of the app. That is affordable because the
   two tags worth having sit in a well-specified corner of the format: a TIFF
   header, three IFDs, and a handful of tag numbers.

   Runs in the browser against the same ArrayBuffer that gets uploaded, so what
   the form shows and what the server stores can never disagree.
   ========================================================================== */

'use strict';

const Exif = (() => {
  // Tag numbers, by the IFD they live in. Named rather than inlined because a
  // bare 0x9003 in the middle of a parser is unreadable a year from now.
  const IFD0 = { MAKE: 0x010f, MODEL: 0x0110, ORIENTATION: 0x0112, DATETIME: 0x0132, EXIF_PTR: 0x8769, GPS_PTR: 0x8825 };
  const EXIF = { DATETIME_ORIGINAL: 0x9003, DATETIME_DIGITIZED: 0x9004, OFFSET_ORIGINAL: 0x9011, SUBSEC_ORIGINAL: 0x9291, PIXEL_X: 0xa002, PIXEL_Y: 0xa003 };
  const GPS = { LAT_REF: 1, LAT: 2, LON_REF: 3, LON: 4, ALT_REF: 5, ALT: 6, TIMESTAMP: 7, DATESTAMP: 0x001d };

  // Bytes per component, indexed by the TIFF type code. Index 0 is unused; the
  // zeroes are the types this parser does not read (and would mis-size).
  const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

  /**
   * Locate the TIFF header, which is where every EXIF block actually begins.
   *
   * Three containers matter in practice:
   *   - JPEG: an APP1 segment whose payload starts "Exif\0\0".
   *   - HEIC/HEIF (every modern iPhone): the same "Exif\0\0" block, but buried
   *     in an ISOBMFF item rather than a marker segment. Walking the box tree
   *     to find it is a lot of code for one offset, so we scan for the
   *     signature instead and confirm it by the byte order mark that must
   *     follow. A false positive would have to be those ten exact bytes.
   *   - Bare TIFF/DNG: the file *is* the TIFF.
   *
   * Returns the offset of the byte-order mark, or -1.
   */
  function findTiff(view) {
    const len = view.byteLength;
    if (len < 12) return -1;

    // Bare TIFF: "II*\0" or "MM\0*" at the very start.
    if (isByteOrderMark(view, 0)) return 0;

    // JPEG: walk the marker segments. Cheaper and stricter than scanning, and
    // it also tells us when a JPEG simply has no APP1 at all.
    if (view.getUint16(0) === 0xffd8) {
      let at = 2;
      while (at + 4 <= len) {
        if (view.getUint8(at) !== 0xff) break; // out of sync; fall through to the scan
        const marker = view.getUint8(at + 1);
        // Standalone markers carry no length. SOS (0xda) means the entropy-coded
        // image data starts here, and no more metadata follows.
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
        if (marker === 0xda) break;
        const size = view.getUint16(at + 2);
        if (size < 2) break;
        if (marker === 0xe1 && at + 4 + 6 <= len && isExifHeader(view, at + 4)) {
          const tiff = at + 10;
          if (isByteOrderMark(view, tiff)) return tiff;
        }
        at += 2 + size;
      }
    }

    // Anything else: scan for "Exif\0\0" + byte order mark. Bounded, because a
    // 200MB video-frame HEIC should not cost a full pass — EXIF lives in the
    // metadata at the front in every file this app will meet.
    const limit = Math.min(len - 12, 4 << 20);
    for (let i = 0; i < limit; i++) {
      if (isExifHeader(view, i) && isByteOrderMark(view, i + 6)) return i + 6;
    }
    return -1;
  }

  const isExifHeader = (view, at) =>
    view.getUint8(at) === 0x45 && view.getUint8(at + 1) === 0x78 &&
    view.getUint8(at + 2) === 0x69 && view.getUint8(at + 3) === 0x66 &&
    view.getUint8(at + 4) === 0x00 && view.getUint8(at + 5) === 0x00;

  function isByteOrderMark(view, at) {
    if (at + 4 > view.byteLength) return false;
    const order = view.getUint16(at);
    if (order !== 0x4949 && order !== 0x4d4d) return false;
    // The 42 that follows is the format's own sanity check. Keeping it is what
    // makes the HEIC scan safe.
    return view.getUint16(at + 2, order === 0x4949) === 42;
  }

  /** Read one IFD into a plain {tag: value} object. */
  function readIfd(view, tiff, offset, le) {
    const out = {};
    if (offset + 2 > view.byteLength) return out;
    const count = view.getUint16(offset, le);
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      const tag = view.getUint16(entry, le);
      const type = view.getUint16(entry + 2, le);
      const n = view.getUint32(entry + 4, le);
      const size = TYPE_SIZE[type];
      if (!size) continue; // a type we do not read
      const bytes = size * n;
      // Up to four bytes are stored in the entry itself; more, and the entry
      // holds an offset from the start of the TIFF header.
      const at = bytes <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, le);
      if (at < 0 || at + bytes > view.byteLength) continue;
      const value = readValue(view, at, type, n, le);
      if (value !== undefined) out[tag] = value;
    }
    return out;
  }

  function readValue(view, at, type, n, le) {
    switch (type) {
      case 2: { // ASCII, NUL-terminated
        let s = '';
        for (let i = 0; i < n; i++) {
          const c = view.getUint8(at + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s.trim();
      }
      case 1: case 7: return one(n, (i) => view.getUint8(at + i));
      case 3: return one(n, (i) => view.getUint16(at + i * 2, le));
      case 4: return one(n, (i) => view.getUint32(at + i * 4, le));
      case 9: return one(n, (i) => view.getInt32(at + i * 4, le));
      case 5: case 10: {
        const signed = type === 10;
        return one(n, (i) => {
          const num = signed ? view.getInt32(at + i * 8, le) : view.getUint32(at + i * 8, le);
          const den = signed ? view.getInt32(at + i * 8 + 4, le) : view.getUint32(at + i * 8 + 4, le);
          return den === 0 ? 0 : num / den;
        });
      }
      case 11: return one(n, (i) => view.getFloat32(at + i * 4, le));
      case 12: return one(n, (i) => view.getFloat64(at + i * 8, le));
      default: return undefined;
    }
  }

  // A single-component tag reads more naturally as a scalar than as [x].
  const one = (n, get) => (n === 1 ? get(0) : Array.from({ length: n }, (_, i) => get(i)));

  /** Degrees / minutes / seconds to a signed decimal degree. */
  function toDegrees(dms, ref) {
    if (dms == null) return null;
    const parts = Array.isArray(dms) ? dms : [dms, 0, 0];
    const [d = 0, m = 0, s = 0] = parts;
    const value = Math.abs(d) + m / 60 + s / 3600;
    if (!Number.isFinite(value)) return null;
    const negative = ref === 'S' || ref === 'W';
    // Six decimals is about 10cm. Anything past that is noise dressed as rigour.
    return Math.round((negative ? -value : value) * 1e6) / 1e6;
  }

  /**
   * "2025:10:12 08:41:03" to "2025-10-12T08:41".
   *
   * Deliberately kept as a *local, zone-less* wall time. That is what the tag
   * means: the clock reading where the shutter fired. Converting it to UTC
   * without knowing the camera's zone would move an early-morning find in the
   * woods to the previous day.
   */
  function toLocalDateTime(stamp) {
    if (typeof stamp !== 'string') return null;
    const m = stamp.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    const [, y, mo, d, h, mi] = m;
    // Cameras with a dead clock battery write zeroes. That is not a date.
    if (y === '0000' || mo === '00' || d === '00') return null;
    return `${y}-${mo}-${d}T${h}:${mi}`;
  }

  /**
   * Everything the log wants to know about one file.
   * Never throws: a photo with no metadata is an ordinary case, not an error,
   * and the form just leaves the user to fill the fields in by hand.
   */
  function read(buffer) {
    const empty = { takenAt: null, offset: null, lat: null, lon: null, altitude: null, make: null, model: null, width: null, height: null, orientation: null, hasExif: false };
    try {
      const view = new DataView(buffer);
      const tiff = findTiff(view);
      if (tiff === -1) return empty;

      const le = view.getUint16(tiff) === 0x4949;
      const first = view.getUint32(tiff + 4, le);
      const ifd0 = readIfd(view, tiff, tiff + first, le);
      const exif = ifd0[IFD0.EXIF_PTR] ? readIfd(view, tiff, tiff + ifd0[IFD0.EXIF_PTR], le) : {};
      const gps = ifd0[IFD0.GPS_PTR] ? readIfd(view, tiff, tiff + ifd0[IFD0.GPS_PTR], le) : {};

      const lat = toDegrees(gps[GPS.LAT], gps[GPS.LAT_REF]);
      const lon = toDegrees(gps[GPS.LON], gps[GPS.LON_REF]);

      // Altitude ref 1 means below sea level; the value itself is unsigned.
      let altitude = null;
      if (typeof gps[GPS.ALT] === 'number') {
        altitude = Math.round(gps[GPS.ALT] * (gps[GPS.ALT_REF] === 1 ? -1 : 1));
      }

      return {
        // Original beats digitized beats the file's own modify stamp: the first
        // is when the shutter fired, the last is when someone copied the file.
        takenAt: toLocalDateTime(exif[EXIF.DATETIME_ORIGINAL])
              || toLocalDateTime(exif[EXIF.DATETIME_DIGITIZED])
              || toLocalDateTime(ifd0[IFD0.DATETIME]),
        offset: typeof exif[EXIF.OFFSET_ORIGINAL] === 'string' ? exif[EXIF.OFFSET_ORIGINAL] : null,
        // A GPS block with no fix writes 0,0. That is in the Atlantic, so it is
        // safe to read it as "no location" rather than as a real coordinate.
        lat: lat === 0 && lon === 0 ? null : lat,
        lon: lat === 0 && lon === 0 ? null : lon,
        altitude,
        make: ifd0[IFD0.MAKE] || null,
        model: ifd0[IFD0.MODEL] || null,
        width: exif[EXIF.PIXEL_X] || null,
        height: exif[EXIF.PIXEL_Y] || null,
        orientation: ifd0[IFD0.ORIENTATION] || null,
        hasExif: true,
      };
    } catch {
      return empty;
    }
  }

  return { read, toDegrees, toLocalDateTime, findTiff };
})();

if (typeof module !== 'undefined') module.exports = Exif;
