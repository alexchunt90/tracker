/*
 * The photo name rules and the reachability walk, shared by the server and
 * the upload script.
 *
 *   node --test test/photos.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const { IMAGE_TYPES, PHOTO_MIME, PHOTO_NAME, mintPhotoName, referencedPhotos } = require('../lib/photos.js');

test('the two tables are inverses', () => {
  for (const [mime, ext] of Object.entries(IMAGE_TYPES)) assert.equal(PHOTO_MIME[ext], mime);
  assert.equal(Object.keys(PHOTO_MIME).length, Object.keys(IMAGE_TYPES).length);
});

test('a minted name is the only shape that is ever looked up', () => {
  for (const ext of Object.values(IMAGE_TYPES)) {
    const name = mintPhotoName(ext);
    assert.match(name, PHOTO_NAME, name);
  }
  assert.notEqual(mintPhotoName('.jpg'), mintPhotoName('.jpg'));
  for (const bad of ['../x.jpg', 'server.js', '0123456789abcdef.jpeg', '0123456789abcdef.JPG',
    '0123456789abcde.jpg', '0123456789abcdef.jpg.tmp', '0123456789abcdeg.png', '', 'x/0123456789abcdef.jpg']) {
    assert.ok(!PHOTO_NAME.test(bad), bad);
  }
});

test('reachability counts every file and thumb any record points at, and tolerates junk', () => {
  const keep = referencedPhotos(
    [{ photos: [{ file: 'a.jpg', thumb: 'b.jpg' }, null, {}] }, { photos: null }, {}],
    [{ photos: [{ file: 'c.png' }, { thumb: 'a.jpg' }] }],
  );
  assert.deepEqual([...keep].sort(), ['a.jpg', 'b.jpg', 'c.png']);
  assert.deepEqual([...referencedPhotos(null, undefined)], []);
});
