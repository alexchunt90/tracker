/*
 * The EXIF reader, against files built here byte by byte.
 *
 * A real photograph would be a better fixture in one way and worse in every
 * other: it is a binary nobody can read in a diff, it carries somebody's
 * coordinates, and it tests one camera's habits rather than the format. So
 * the fixtures are assembled from the spec — a TIFF header, three IFDs, and
 * the handful of tags the log reads — in both byte orders.
 *
 *   node --test test/exif.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const Exif = require('../public/exif.js');

/**
 * Build a TIFF block with IFD0, an EXIF IFD and a GPS IFD.
 *
 * Every entry is `[tag, type, values]`. Values that fit in four bytes are
 * inlined; longer ones go to a data area after the IFDs, which is where the
 * offset arithmetic the reader has to get right actually gets exercised.
 */
function tiff({ le = true, ifd0 = [], exif = [], gps = [] } = {}) {
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const chunks = [];
  const header = Buffer.alloc(8);
  header.write(le ? 'II' : 'MM', 0, 'ascii');
  le ? header.writeUInt16LE(42, 2) : header.writeUInt16BE(42, 2);
  le ? header.writeUInt32LE(8, 4) : header.writeUInt32BE(8, 4);
  chunks.push(header);

  const u16 = (b, v, at) => (le ? b.writeUInt16LE(v, at) : b.writeUInt16BE(v, at));
  const u32 = (b, v, at) => (le ? b.writeUInt32LE(v, at) : b.writeUInt32BE(v, at));

  // Lay the three IFDs out back to back, then the overflow data after them.
  // The pointers to the sub-IFDs are entries of IFD0, so they are counted
  // into its size before any offset is computed.
  const lists = [ifd0.slice(), exif.slice(), gps.slice()];
  const ifdSize = (entries) => 2 + entries.length * 12 + 4;
  if (lists[1].length) lists[0].push([0x8769, 4, [0]]);
  if (lists[2].length) lists[0].push([0x8825, 4, [0]]);
  const offsets = [8];
  offsets[1] = offsets[0] + ifdSize(lists[0]);
  offsets[2] = offsets[1] + ifdSize(lists[1]);
  for (const entry of lists[0]) {
    if (entry[0] === 0x8769) entry[2] = [offsets[1]];
    if (entry[0] === 0x8825) entry[2] = [offsets[2]];
  }
  let dataAt = offsets[2] + ifdSize(lists[2]);
  const data = [];

  const encode = (type, values) => {
    if (type === 2) {
      const s = Buffer.from(values[0] + '\0', 'ascii');
      return { bytes: s, count: s.length };
    }
    const size = SIZE[type];
    const out = Buffer.alloc(size * values.length);
    values.forEach((v, i) => {
      if (type === 1 || type === 7) out.writeUInt8(v, i);
      else if (type === 3) u16(out, v, i * 2);
      else if (type === 4) u32(out, v, i * 4);
      else if (type === 5) { u32(out, v[0], i * 8); u32(out, v[1], i * 8 + 4); }
    });
    return { bytes: out, count: values.length };
  };

  for (const entries of lists) {
    const ifd = Buffer.alloc(ifdSize(entries));
    u16(ifd, entries.length, 0);
    entries.forEach(([tag, type, values], n) => {
      const at = 2 + n * 12;
      const { bytes, count } = encode(type, values);
      u16(ifd, tag, at);
      u16(ifd, type, at + 2);
      u32(ifd, count, at + 4);
      if (bytes.length <= 4) bytes.copy(ifd, at + 8);
      else { u32(ifd, dataAt, at + 8); data.push(bytes); dataAt += bytes.length; }
    });
    chunks.push(ifd);
  }
  return Buffer.concat([...chunks, ...data]);
}

/** Wrap a TIFF block in a JPEG's APP1 segment, after a decoy segment. */
function jpeg(tiffBlock) {
  const soi = Buffer.from([0xff, 0xd8]);
  // A JFIF APP0 first, so the walk has to step over a segment it does not want.
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiffBlock]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  const sos = Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]);
  return Buffer.concat([soi, app0, app1, sos]);
}

const toBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

const FULL = {
  ifd0: [[0x010f, 2, ['Apple']], [0x0110, 2, ['iPhone 15']], [0x0112, 3, [6]], [0x0132, 2, ['2025:10:12 09:00:00']]],
  exif: [[0x9003, 2, ['2025:10:12 08:41:03']], [0x9011, 2, ['-07:00']], [0xa002, 4, [4032]], [0xa003, 4, [3024]]],
  gps: [
    [1, 2, ['N']], [2, 5, [[47, 1], [33, 1], [3600, 100]]],
    [3, 2, ['W']], [4, 5, [[123, 1], [7, 1], [5, 1]]],
    [5, 1, [0]], [6, 5, [[3641, 10]]],
  ],
};

for (const le of [true, false]) {
  test(`a ${le ? 'little' : 'big'}-endian JPEG gives up when, where and how high`, () => {
    const meta = Exif.read(toBuffer(jpeg(tiff({ le, ...FULL }))));
    assert.equal(meta.hasExif, true);
    assert.equal(meta.takenAt, '2025-10-12T08:41');
    assert.equal(meta.offset, '-07:00');
    assert.equal(meta.lat, 47.56);
    assert.equal(meta.lon, -123.118056);
    assert.equal(meta.altitude, 364);
    assert.equal(meta.make, 'Apple');
    assert.equal(meta.model, 'iPhone 15');
    assert.equal(meta.width, 4032);
    assert.equal(meta.height, 3024);
    assert.equal(meta.orientation, 6);
  });
}

test('a bare TIFF is the TIFF, and the same block buried in a HEIC is found by scanning', () => {
  const block = tiff(FULL);
  assert.equal(Exif.findTiff(new DataView(toBuffer(block))), 0);
  assert.equal(Exif.read(toBuffer(block)).takenAt, '2025-10-12T08:41');

  // ISOBMFF-ish: some boxes, then the Exif payload somewhere in the middle.
  const noise = Buffer.alloc(300, 0x41);
  const heic = Buffer.concat([Buffer.from('\0\0\0\x18ftypheic', 'binary'), noise, Buffer.from('Exif\0\0', 'binary'), block, noise]);
  const at = Exif.findTiff(new DataView(toBuffer(heic)));
  assert.equal(at, 4 + 8 + 300 + 6);
  assert.equal(Exif.read(toBuffer(heic)).lat, 47.56);
});

test('the date falls back from original to digitized to the file stamp', () => {
  const only = (exif, ifd0 = []) => Exif.read(toBuffer(jpeg(tiff({ exif, ifd0 })))).takenAt;
  assert.equal(only([[0x9004, 2, ['2025:01:02 03:04:05']]]), '2025-01-02T03:04');
  assert.equal(only([], [[0x0132, 2, ['2025:06:07 08:09:10']]]), '2025-06-07T08:09');
  assert.equal(only([[0x9003, 2, ['2025:01:02 03:04:05']], [0x9004, 2, ['2024:01:01 00:00:00']]]), '2025-01-02T03:04');
});

test('below sea level, and the southern and western hemispheres', () => {
  const meta = Exif.read(toBuffer(jpeg(tiff({ gps: [
    [1, 2, ['S']], [2, 5, [[33, 1], [51, 1], [0, 1]]],
    [3, 2, ['E']], [4, 5, [[151, 1], [12, 1], [0, 1]]],
    [5, 1, [1]], [6, 5, [[12, 1]]],
  ] }))));
  assert.equal(meta.lat, -33.85);
  assert.equal(meta.lon, 151.2);
  assert.equal(meta.altitude, -12);
});

test('a GPS block with no fix is no location, not a point in the Atlantic', () => {
  const meta = Exif.read(toBuffer(jpeg(tiff({ gps: [
    [1, 2, ['N']], [2, 5, [[0, 1], [0, 1], [0, 1]]], [3, 2, ['E']], [4, 5, [[0, 1], [0, 1], [0, 1]]],
  ] }))));
  assert.equal(meta.lat, null);
  assert.equal(meta.lon, null);
  assert.equal(meta.hasExif, true);
});

test('no metadata is an ordinary case, not an error', () => {
  const empty = { takenAt: null, offset: null, lat: null, lon: null, altitude: null, make: null, model: null, width: null, height: null, orientation: null, hasExif: false };
  assert.deepEqual(Exif.read(toBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))), empty);
  assert.deepEqual(Exif.read(new ArrayBuffer(0)), empty);
  assert.deepEqual(Exif.read(toBuffer(Buffer.alloc(64, 0x00))), empty);
  // A truncated file — the offsets point past the end — reads as nothing
  // rather than throwing.
  const cut = jpeg(tiff(FULL)).subarray(0, 60);
  assert.ok(typeof Exif.read(toBuffer(cut)) === 'object');
});

test('the two conversions on their own', () => {
  assert.equal(Exif.toDegrees([47, 30, 0], 'N'), 47.5);
  assert.equal(Exif.toDegrees([47, 30, 0], 'S'), -47.5);
  assert.equal(Exif.toDegrees(47.5, 'W'), -47.5);
  assert.equal(Exif.toDegrees(null, 'N'), null);
  assert.equal(Exif.toDegrees([NaN, 0, 0], 'N'), null);
  assert.equal(Exif.toLocalDateTime('2025:10:12 08:41:03'), '2025-10-12T08:41');
  assert.equal(Exif.toLocalDateTime('2025-10-12T08:41'), '2025-10-12T08:41');
  // A dead clock battery writes zeroes. That is not a date.
  assert.equal(Exif.toLocalDateTime('0000:00:00 00:00:00'), null);
  assert.equal(Exif.toLocalDateTime(''), null);
  assert.equal(Exif.toLocalDateTime(42), null);
});
