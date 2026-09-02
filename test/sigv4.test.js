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
 *   node test/sigv4.test.js
 *
 * The vectors below were captured from `aws s3api ... --debug` using AWS's
 * published example credentials, which are not real keys. To regenerate one,
 * run the same command with those credentials in the environment and read the
 * Authorization header out of the AWSPreparedRequest line.
 */
const assert = require('node:assert');
const { sign, escapePath } = require('../lib/store.js');

const CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};
const signatureOf = (h) => /Signature=([0-9a-f]{64})/.exec(h.authorization)[1];
const signedOf = (h) => /SignedHeaders=([^,]+)/.exec(h.authorization)[1];

let failures = 0;
const check = (name, actual, expected) => {
  try {
    assert.strictEqual(actual, expected);
    console.log(`  ok    ${name}`);
  } catch {
    failures++;
    console.log(`  FAIL  ${name}\n          got      ${actual}\n          expected ${expected}`);
  }
};

// --- GET an object, with an extra signed header -----------------------------
{
  const url = new URL('https://examplebucket.s3.us-east-1.amazonaws.com/test.txt');
  const h = sign('GET', url, { 'x-amz-checksum-mode': 'ENABLED' }, '', CREDS,
    new Date('2026-09-02T20:24:28Z'));
  check('GET signature', signatureOf(h),
    '12fd1e73981e06b296c22cf7c232a72519daba7782dfbfd23cf0974718f40e22');
  check('GET signed headers', signedOf(h),
    'host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date');
}

// --- PUT with a body, whose hash goes into the signature --------------------
{
  const url = new URL('https://examplebucket.s3.us-east-1.amazonaws.com/testfile.text');
  const h = sign('PUT', url, {}, 'Welcome to Amazon S3.', CREDS,
    new Date('2026-09-02T20:25:14Z'));
  check('PUT signature', signatureOf(h),
    '093af7c84219c1f2d31d6041f70bc470049a704ac8ab8d48b0b8b9393aa4cc7f');
  check('PUT hashes the body', h['x-amz-content-sha256'],
    '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
}

// --- LIST, where the query string is canonicalised separately ---------------
{
  const url = new URL('https://examplebucket.s3.us-east-1.amazonaws.com/'
    + '?list-type=2&max-keys=2&prefix=J&encoding-type=url');
  const h = sign('GET', url, {}, '', CREDS, new Date('2026-09-02T20:25:13Z'));
  check('LIST signature', signatureOf(h),
    '4996a5c261de8dfc33b54d1d338d2800d6b9974c4b2ae63bab79695955123212');
}

// --- the encoding rules the signature depends on ----------------------------
check('escapePath leaves separators alone', escapePath('a/b/c.json'), '/a/b/c.json');
check('escapePath encodes a space', escapePath('two words.jpg'), '/two%20words.jpg');
check("escapePath encodes !*'() which encodeURIComponent skips",
  escapePath("odd!*'()name"), '/odd%21%2A%27%28%29name');
check('photo keys pass through untouched',
  escapePath('photos/0a1b2c3d4e5f6071.jpg'), '/photos/0a1b2c3d4e5f6071.jpg');

console.log(failures ? `\n${failures} failing` : '\nall signing vectors pass');
process.exit(failures ? 1 : 0);
