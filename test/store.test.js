/*
 * The store: two backends, one guarantee.
 *
 * A read hands back a token for the exact stored version, and a write that
 * presents a stale token is refused. That is the property that keeps two
 * instances sharing a bucket from silently overwriting each other, and the
 * filesystem backend has to make the same promise so the race shows up in
 * development.
 *
 * The S3 backend is exercised against a fake `fetch` that records what would
 * have gone on the wire. The signing itself is checked in sigv4.test.js.
 *
 *   node --test test/store.test.js
 */
const assert = require('node:assert');
const { test, describe, beforeEach, afterEach } = require('node:test');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore, StoreConflict, KEYS, serialize } = require('../lib/store.js');

describe('the filesystem backend', () => {
  let root;
  let store;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-store-'));
    store = createStore({}, root, path.join(root, 'photos'));
  });
  afterEach(() => fsp.rm(root, { recursive: true, force: true }));

  test('absent is a state, not a failure, and a null token creates', async () => {
    assert.equal(store.kind, 'file');
    assert.deepEqual(await store.read('config'), { value: undefined, token: null });

    const { token } = await store.write('config', { version: 1 }, null);
    assert.ok(token);
    const held = await store.read('config');
    assert.deepEqual(held.value, { version: 1 });
    assert.equal(held.token, token);
    // Under the documented path, pretty-printed, so a diff of the file reads.
    assert.equal(await fsp.readFile(path.join(root, KEYS.config), 'utf8'), serialize({ version: 1 }));
  });

  test('a write must present the token of what it is replacing', async () => {
    const first = await store.write('observations', [], null);
    // Creating something that already exists is a conflict.
    await assert.rejects(store.write('observations', [{ id: 'a' }], null), StoreConflict);
    const second = await store.write('observations', [{ id: 'a' }], first.token);
    assert.notEqual(second.token, first.token);
    // The token that won once does not win twice.
    await assert.rejects(store.write('observations', [{ id: 'b' }], first.token), StoreConflict);
    assert.deepEqual((await store.read('observations')).value, [{ id: 'a' }]);
  });

  test('concurrent writes against one token let exactly one through', async () => {
    const { token } = await store.write('species', [], null);
    const results = await Promise.allSettled([1, 2, 3, 4].map((n) => store.write('species', [{ n }], token)));
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1);
    assert.equal(lost.length, 3);
    for (const r of lost) assert.ok(r.reason instanceof StoreConflict);
  });

  test('an interrupted write leaves no temp file behind and the old file intact', async () => {
    await store.write('glossary', { version: 1, terms: {} }, null);
    const dir = path.join(root, 'data');
    assert.deepEqual(await fsp.readdir(dir), ['glossary.json']);
  });

  test('photographs are plain files with no token at all', async () => {
    assert.deepEqual(await store.listPhotos(), []);
    assert.equal(await store.readPhoto('0123456789abcdef.jpg'), null);

    await store.writePhoto('0123456789abcdef.jpg', Buffer.from('jpeg bytes'), 'image/jpeg');
    assert.equal((await store.readPhoto('0123456789abcdef.jpg')).toString(), 'jpeg bytes');
    const listed = await store.listPhotos();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, '0123456789abcdef.jpg');
    assert.ok(Number.isFinite(listed[0].modified));

    await store.deletePhoto('0123456789abcdef.jpg');
    await store.deletePhoto('0123456789abcdef.jpg'); // already gone is fine
    assert.deepEqual(await store.listPhotos(), []);
  });
});

describe('choosing a backend', () => {
  test('a bucket needs credentials, and says which are missing', () => {
    assert.throws(() => createStore({ S3_BUCKET: 'b' }, '/tmp', '/tmp/photos'),
      /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
    assert.throws(() => createStore({ S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'k' }, '/tmp', '/tmp/photos'),
      /AWS_SECRET_ACCESS_KEY must/);
    const s3 = createStore({ S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' }, '/tmp', '/tmp/photos');
    assert.equal(s3.kind, 's3');
    assert.equal(s3.describe(), 's3://b/');
  });
});

describe('the S3 backend', () => {
  const ENV = { S3_BUCKET: 'my-log', S3_PREFIX: '/notes/', AWS_REGION: 'us-west-2',
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret' };

  const calls = [];
  const realFetch = globalThis.fetch;
  let answer = () => new Response('', { status: 404 });

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
      return answer(String(url), init);
    };
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('objects live under the prefix, virtual-host style against AWS', async () => {
    const store = createStore(ENV, '/tmp', '/tmp/photos');
    assert.equal(store.describe(), 's3://my-log/notes/');
    assert.deepEqual(await store.read('config'), { value: undefined, token: null });
    assert.equal(calls[0].url, 'https://my-log.s3.us-west-2.amazonaws.com/notes/config.json');
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-west-2\/s3\/aws4_request/);
  });

  test('a custom endpoint goes path-style, which is what R2 and MinIO speak', async () => {
    const store = createStore({ ...ENV, S3_ENDPOINT: 'https://minio.local:9000/' }, '/tmp', '/tmp/photos');
    assert.equal(store.describe(), 'https://minio.local:9000//my-log/notes/');
    await store.readPhoto('0123456789abcdef.jpg');
    assert.equal(calls[0].url, 'https://minio.local:9000/my-log/notes/photos/0123456789abcdef.jpg');
  });

  test('the token is the ETag, and a write presents it as a condition', async () => {
    const store = createStore(ENV, '/tmp', '/tmp/photos');
    answer = () => new Response(JSON.stringify({ version: 3 }), { status: 200, headers: { etag: '"abc"' } });
    const held = await store.read('config');
    assert.deepEqual(held, { value: { version: 3 }, token: '"abc"' });

    answer = () => new Response('', { status: 200, headers: { etag: '"def"' } });
    const written = await store.write('config', { version: 4 }, '"abc"');
    assert.equal(written.token, '"def"');
    const put = calls[1];
    assert.equal(put.method, 'PUT');
    assert.equal(put.headers['if-match'], '"abc"');
    assert.equal(put.body, serialize({ version: 4 }));

    // No token means "must not exist yet", so two instances cannot both seed.
    await store.write('config', { version: 1 }, null);
    assert.equal(calls[2].headers['if-none-match'], '*');
    assert.equal(calls[2].headers['if-match'], undefined);
  });

  test('a failed condition is a conflict, whichever way S3 reports it', async () => {
    const store = createStore(ENV, '/tmp', '/tmp/photos');
    answer = () => new Response('', { status: 412 });
    await assert.rejects(store.write('species', [], '"old"'), StoreConflict);
    answer = () => new Response('', { status: 409 });
    await assert.rejects(store.write('species', [], '"old"'), StoreConflict);
  });

  test('a 403 explains the ListBucket trap rather than just saying denied', async () => {
    const store = createStore(ENV, '/tmp', '/tmp/photos');
    answer = () => new Response('<Error><Message>no identity-based policy allows the s3:GetObject action</Message></Error>', { status: 403 });
    await assert.rejects(store.read('config'), (err) =>
      /no policy granting/.test(err.message) && /ListBucket/.test(err.message));
    // A missing photograph reads as absent either way: the sweep must not
    // fail the request that already succeeded.
    assert.equal(await store.readPhoto('0123456789abcdef.jpg'), null);
  });

  test('listing follows continuation tokens and strips the prefix', async () => {
    const store = createStore(ENV, '/tmp', '/tmp/photos');
    const page = (keys, next) => `<ListBucketResult>${keys.map((k) =>
      `<Contents><Key>${k}</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified></Contents>`).join('')}` +
      (next ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${next}</NextContinuationToken>` : '<IsTruncated>false</IsTruncated>') +
      '</ListBucketResult>';
    answer = (url) => new Response(url.includes('continuation-token')
      ? page(['notes/photos/bbbb.jpg'])
      : page(['notes/photos/aaaa.jpg', 'notes/photos/'], 'tok=en'), { status: 200 });

    const listed = await store.listPhotos();
    assert.deepEqual(listed.map((p) => p.name), ['aaaa.jpg', 'bbbb.jpg']);
    assert.equal(listed[0].modified, Date.parse('2026-01-02T03:04:05.000Z'));
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /^https:\/\/my-log\.s3\.us-west-2\.amazonaws\.com\/\?list-type=2&prefix=notes%2Fphotos%2F/);
    assert.match(calls[1].url, /continuation-token=tok%3Den/);
  });
});
