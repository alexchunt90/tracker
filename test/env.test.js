/*
 * The .env loader shared by the server and the scripts.
 *
 *   node --test test/env.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadEnv } = require('../lib/env.js');

const withFile = async (text, fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-env-'));
  const file = path.join(dir, '.env');
  try {
    if (text !== null) await fsp.writeFile(file, text, 'utf8');
    return await fn(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
};

test('a missing file is fine', () => withFile(null, (file) => {
  const env = {};
  assert.equal(loadEnv(file, env), env);
  assert.deepEqual(env, {});
}));

test('KEY=value lines, with comments, blanks and quotes handled', () => withFile(`
# the bucket
S3_BUCKET=my-log
S3_PREFIX = "field notes"
AWS_REGION='us-west-2'
ODD="unterminated
EMPTY=
NOEQUALS
  HOST=127.0.0.1  
`, (file) => {
  const env = loadEnv(file, {});
  assert.deepEqual(env, {
    S3_BUCKET: 'my-log',
    S3_PREFIX: 'field notes',
    AWS_REGION: 'us-west-2',
    ODD: '"unterminated',
    EMPTY: '',
    HOST: '127.0.0.1',
  });
}));

test('the real environment always wins, even when set to nothing', () => withFile('PORT=5000\nS3_BUCKET=b\n', (file) => {
  const env = loadEnv(file, { PORT: '4175', S3_BUCKET: '' });
  assert.equal(env.PORT, '4175');
  // Present-but-empty is how a test switches the bucket off; the file must
  // not switch it back on.
  assert.equal(env.S3_BUCKET, '');
}));

test('a value may contain an equals sign', () => withFile('TOKEN=abc=def==\n', (file) => {
  assert.equal(loadEnv(file, {}).TOKEN, 'abc=def==');
}));
