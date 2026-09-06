/*
 * The SigV4 signing, checked against reference signatures produced by
 * botocore — the AWS CLI's own signer — for the same inputs.
 *
 * This exists because the signing cannot be tested against the real bucket
 * without credentials allowed to touch it, and when a signature is wrong S3
 * says 403, which is exactly what it says when the policy is wrong. Being able
 * to rule one of those out on its own is the difference between a five-minute
 * fix and an afternoon.
 *
 *   node --test test/sigv4.test.js
 *
 * The vectors below were captured from `aws s3api ... --debug` using AWS's
 * published example credentials, which are not real keys. To regenerate one,
 * run the same command with those credentials in the environment and read the
 * Authorization header out of the AWSPreparedRequest line.
 */
const assert = require('node:assert');
const { test } = require('node:test');
const { sign, escapePath } = require('../lib/store.js');

const CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};
const signatureOf = (h) => /Signature=([0-9a-f]{64})/.exec(h.authorization)[1];
const signedOf = (h) => /SignedHeaders=([^,]+)/.exec(h.authorization)[1];

test('GET an object, with an extra signed header', () => {
  const url = new URL('https://examplebucket.s3.us-east-1.amazonaws.com/test.txt');
  const h = sign('GET', url, { 'x-amz-checksum-mode': 'ENABLED' }, '', CREDS,
    new Date('2026-09-02T20:24:28Z'));
  assert.strictEqual(signatureOf(h), '12fd1e73981e06b296c22cf7c232a72519daba7782dfbfd23cf0974718f40e22');
  assert.strictEqual(signedOf(h), 'host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date');
});

test('PUT with a body, whose hash goes into the signature', () => {
  const url = new URL('https://examplebucket.s3.us-east-1.amazonaws.com/testfile.text');
  const h = sign('PUT', url, {}, 'Welcome to Amazon S3.', CREDS,
    new Date('2026-09-02T20:25:14Z'));
  assert.strictEqual(signatureOf(h), '093af7c84219c1f2d31d6041f70bc470049a704ac8ab8d48b0b8b9393aa4cc7f');
  assert.strictEqual(h['x-amz-content-sha256'], '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
});

test('LIST, where the query string is canonicalised separately', () => {
  const url = new URL('https://examplebucket.s3.us-east-1.amazonaws.com/'
    + '?list-type=2&max-keys=2&prefix=J&encoding-type=url');
  const h = sign('GET', url, {}, '', CREDS, new Date('2026-09-02T20:25:13Z'));
  assert.strictEqual(signatureOf(h), '4996a5c261de8dfc33b54d1d338d2800d6b9974c4b2ae63bab79695955123212');
});

test('a session token is signed along with everything else', () => {
  const url = new URL('https://examplebucket.s3.us-east-1.amazonaws.com/test.txt');
  const h = sign('GET', url, {}, '', { ...CREDS, sessionToken: 'tok' }, new Date('2026-09-02T20:24:28Z'));
  assert.strictEqual(h['x-amz-security-token'], 'tok');
  assert.match(signedOf(h), /x-amz-security-token/);
});

test('the encoding rules the signature depends on', () => {
  assert.strictEqual(escapePath('a/b/c.json'), '/a/b/c.json');
  assert.strictEqual(escapePath('two words.jpg'), '/two%20words.jpg');
  // encodeURIComponent skips !*'() and S3 does not.
  assert.strictEqual(escapePath("odd!*'()name"), '/odd%21%2A%27%28%29name');
  assert.strictEqual(escapePath('photos/0a1b2c3d4e5f6071.jpg'), '/photos/0a1b2c3d4e5f6071.jpg');
});
