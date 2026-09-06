'use strict';

/* ---------------------------------------------------------------------------
 * What a stored photograph is called, and what it may be.
 *
 * Shared by the server, which mints the names and serves the files, and the
 * upload script, which pushes a checkout's photographs into a bucket. Both
 * have to agree on which files are photographs and what type each one is
 * served as, and they agree by reading it from here.
 * ------------------------------------------------------------------------- */

const crypto = require('node:crypto');

// What may be uploaded, and what each type is stored as. The extension comes
// from this table rather than from the client's filename: a name is attacker
// controlled, and it is the only thing that decides how the file is served
// back later.
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
};

/** The inverse: extension to the type it is served as. */
const PHOTO_MIME = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([m, e]) => [e, m]));

// Serving a stored file is the one place a request string reaches the
// filesystem, so the name is required to be exactly what we mint: hex plus a
// known extension. Nothing else is even looked up, which makes traversal and
// symlink tricks unrepresentable rather than merely filtered.
const PHOTO_NAME = new RegExp(`^[0-9a-f]{16}\\.(${Object.values(IMAGE_TYPES).map((e) => e.slice(1)).join('|')})$`);

/** A fresh name. Never reused, which is what lets the bytes behind it be immutable. */
const mintPhotoName = (ext) => crypto.randomBytes(8).toString('hex') + ext;

/**
 * Every photo filename referenced by any saved record — the reachability the
 * orphan sweep and the upload script both run on.
 */
function referencedPhotos(observations, species) {
  const set = new Set();
  for (const record of [...(observations || []), ...(species || [])]) {
    for (const p of record.photos || []) {
      if (p?.file) set.add(p.file);
      if (p?.thumb) set.add(p.thumb);
    }
  }
  return set;
}

module.exports = { IMAGE_TYPES, PHOTO_MIME, PHOTO_NAME, mintPhotoName, referencedPhotos };
