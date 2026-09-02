/* ---------------------------------------------------------------------------
 * Where the state lives.
 *
 * Two backends behind one interface: the local filesystem, and any
 * S3-compatible object store. The app's own concurrency check — a `version`
 * field the client echoes back — only protects against a *stale client*. It
 * assumes the server's read-modify-write is atomic, which it is on one box
 * with one process and is not across several instances sharing a bucket.
 *
 * So a read also hands back a token identifying that exact stored version, and
 * a write presents the token back and is refused if the stored version has
 * moved on since. On S3 that token is the ETag and the refusal is a
 * conditional PUT; on the filesystem it is a hash of the bytes and the check is
 * a re-read under a lock. Same guarantee either way, which means a race shows
 * up in development rather than only in production.
 *
 * This log also stores photographs, which the finances app it borrows from did
 * not. They are a different kind of thing: named by a freshly minted id, never
 * rewritten, and large. So they get their own half of the interface with no
 * version token at all — a name is claimed once and the bytes under it never
 * change, which is the one case where last-writer-wins cannot lose anything.
 *
 * No dependencies here: the S3 requests are signed with SigV4 using
 * node:crypto, which is a page of well-specified arithmetic and keeps
 * `npm install` at nothing.
 * ------------------------------------------------------------------------- */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** Another writer got there first. The caller retries, or reports a conflict. */
class StoreConflict extends Error {
  constructor(key) {
    super(`${key} was written by someone else`);
    this.name = 'StoreConflict';
    this.key = key;
  }
}

// The four documents, and where each one sits under the state root. Keys are
// what the rest of the app names; paths are an implementation detail.
const KEYS = {
  config: 'config.json',
  observations: 'data/observations.json',
  species: 'data/species.json',
  glossary: 'data/glossary.json',
};

const PHOTO_PREFIX = 'photos/';

const serialize = (value) => JSON.stringify(value, null, 2) + '\n';

/**
 * RFC 3986 percent-encoding, which is what S3 canonicalises a path to before
 * checking a signature. encodeURIComponent leaves !*'() alone and S3 does not,
 * so a prefix containing one would sign correctly here and be rejected there.
 * Slashes are encoded per segment so they survive as separators.
 */
const escapePath = (key) => '/' + key.split('/').map((seg) =>
  encodeURIComponent(seg).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
).join('/');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// --- filesystem -------------------------------------------------------------

function fileStore(root, photoDir) {
  const pathFor = (key) => path.join(root, KEYS[key]);

  // Checking the stored version and replacing it have to happen together, or
  // the check is decorative: two requests both read the same version, both
  // decide they are current, and the second quietly overwrites the first. A
  // filesystem offers nothing to do that atomically, so writes are run one at
  // a time. That covers one process, which is all this backend claims —
  // several instances sharing state need the bucket, where the check is the
  // store's own and holds across machines.
  let chain = Promise.resolve();
  const underLock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };

  async function read(key) {
    try {
      const raw = await fsp.readFile(pathFor(key), 'utf8');
      return { value: JSON.parse(raw), token: sha256(raw) };
    } catch (err) {
      // Absent is a state, not a failure: a fresh checkout has no log yet. A
      // null token then means "this must not exist when I write".
      if (err.code === 'ENOENT') return { value: undefined, token: null };
      throw err;
    }
  }

  const write = (key, value, token) => underLock(async () => {
    const file = pathFor(key);
    const held = await read(key);
    if (held.token !== token) throw new StoreConflict(key);

    const raw = serialize(value);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Via a sibling temp file and a rename. On the same filesystem the rename
    // is atomic, so an interrupted save leaves the previous file intact rather
    // than a half-written one — losing the log to a truncated write would be
    // unrecoverable by hand.
    //
    // The name has to be unique per write, not per process: two requests
    // saving at once would otherwise share one temp file, and each would
    // rename the other's half-written bytes into place.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, raw, 'utf8');
    await fsp.rename(tmp, file);
    return { token: sha256(raw) };
  });

  const photoPath = (name) => path.join(photoDir, name);

  async function readPhoto(name) {
    try {
      return await fsp.readFile(photoPath(name));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writePhoto(name, body) {
    await fsp.mkdir(photoDir, { recursive: true });
    // Names are minted fresh, so there is nothing here to clobber.
    await fsp.writeFile(photoPath(name), body);
  }

  async function deletePhoto(name) {
    await fsp.unlink(photoPath(name)).catch(() => {});
  }

  async function listPhotos() {
    const names = await fsp.readdir(photoDir).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const out = [];
    for (const name of names) {
      const stat = await fsp.stat(photoPath(name)).catch(() => null);
      if (stat?.isFile()) out.push({ name, modified: stat.mtimeMs });
    }
    return out;
  }

  return {
    read, write, readPhoto, writePhoto, deletePhoto, listPhotos,
    describe: () => root, kind: 'file',
  };
}

// --- S3 ---------------------------------------------------------------------

/**
 * Sign a request the way AWS wants it. The canonical request, the string to
 * sign, and the derived key are all exactly as specified — the order and the
 * trailing newlines matter, which is why this reads so fussily.
 */
function sign(method, url, headers, body, creds, now = new Date()) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? '');

  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim();
  h.host = url.host;
  h['x-amz-date'] = amzDate;
  h['x-amz-content-sha256'] = payloadHash;
  if (creds.sessionToken) h['x-amz-security-token'] = creds.sessionToken;

  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join('');
  const signedNames = names.join(';');
  const query = [...url.searchParams.keys()].sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(url.searchParams.get(k))}`)
    .join('&');

  // url.pathname is already percent-encoded, and encoding it again would turn
  // every %2F into %252F.
  const canonicalRequest =
    [method, url.pathname, query, canonicalHeaders, signedNames, payloadHash].join('\n');
  const scope = `${dateStamp}/${creds.region}/s3/aws4_request`;
  const stringToSign =
    ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, 's3');
  const signature = crypto
    .createHmac('sha256', hmac(kService, 'aws4_request'))
    .update(stringToSign)
    .digest('hex');

  h.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedNames}, Signature=${signature}`;
  return h;
}

/**
 * A 403 from S3 is ambiguous in a way worth naming out loud. Without
 * s3:ListBucket, an object that simply is not there is reported as denied
 * rather than absent — so an empty bucket is indistinguishable from bad
 * credentials, and the seed that should populate it never runs.
 */
function denialAdvice(action, resource, body) {
  const why = /no identity-based policy allows/.test(body)
    ? 'The IAM user has no policy granting that action.'
    : 'Either the credentials are wrong, or the policy does not cover this key.';
  return new Error(
    `S3 ${action} ${resource} -> 403. ${why} The app needs s3:GetObject, ` +
    `s3:PutObject and s3:DeleteObject on the objects, plus s3:ListBucket on ` +
    `the bucket — without ListBucket a missing object reads as denied rather ` +
    `than absent, and photographs cannot be swept.`
  );
}

function s3Store(cfg) {
  const prefix = cfg.prefix ? `${cfg.prefix.replace(/^\/+|\/+$/g, '')}/` : '';

  // Virtual-host style against AWS, path style against anything with an
  // explicit endpoint — which is what Cloudflare R2 and MinIO speak, so this
  // same code moves to either by changing one environment variable.
  // The path is escaped once, here, and the URL parser preserves the escapes,
  // so what goes on the wire and what gets signed are the same string.
  const urlFor = (objectPath, query = '') => {
    const base = cfg.endpoint
      ? cfg.endpoint.replace(/\/+$/, '') + escapePath(`${cfg.bucket}/${prefix}${objectPath}`)
      : `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com` + escapePath(`${prefix}${objectPath}`);
    return new URL(base + query);
  };

  const bucketUrl = (query) => new URL(cfg.endpoint
    ? cfg.endpoint.replace(/\/+$/, '') + escapePath(cfg.bucket) + query
    : `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/` + query);

  async function call(method, url, { body, headers = {} } = {}) {
    const signed = sign(method, url, headers, body, cfg);
    const controller = new AbortController();
    // Photographs are megabytes, not kilobytes; a document timeout would cut
    // them off mid-upload on a slow connection.
    const timer = setTimeout(() => controller.abort(), body && body.length > 65536 ? 60000 : 15000);
    try {
      return await fetch(url, { method, headers: signed, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function read(key) {
    const res = await call('GET', urlFor(KEYS[key]));
    if (res.status === 404) return { value: undefined, token: null };
    if (res.status === 403) throw denialAdvice('GET', KEYS[key], await res.text());
    if (!res.ok) throw new Error(`S3 GET ${KEYS[key]} -> ${res.status} ${await res.text()}`);
    return { value: JSON.parse(await res.text()), token: res.headers.get('etag') };
  }

  async function write(key, value, token) {
    const res = await call('PUT', urlFor(KEYS[key]), {
      body: serialize(value),
      headers: {
        'content-type': 'application/json',
        // A token says which version this write is replacing. No token says the
        // object must not exist at all — otherwise two instances starting at
        // once would each create it and one would vanish.
        ...(token ? { 'if-match': token } : { 'if-none-match': '*' }),
      },
    });
    // 412 is the condition failing; 409 is S3 reporting two conditional writes
    // racing each other. Both mean the same thing: read again and redo it.
    if (res.status === 412 || res.status === 409) throw new StoreConflict(key);
    if (res.status === 403) throw denialAdvice('PUT', KEYS[key], await res.text());
    if (!res.ok) throw new Error(`S3 PUT ${KEYS[key]} -> ${res.status} ${await res.text()}`);
    return { token: res.headers.get('etag') };
  }

  async function readPhoto(name) {
    const res = await call('GET', urlFor(PHOTO_PREFIX + name));
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`S3 GET ${name} -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function writePhoto(name, body, contentType) {
    const res = await call('PUT', urlFor(PHOTO_PREFIX + name), {
      body,
      headers: { 'content-type': contentType || 'application/octet-stream' },
    });
    if (res.status === 403) throw denialAdvice('PUT', PHOTO_PREFIX + name, await res.text());
    if (!res.ok) throw new Error(`S3 PUT ${name} -> ${res.status} ${await res.text()}`);
  }

  async function deletePhoto(name) {
    // On a versioned bucket this writes a delete marker rather than destroying
    // the bytes, so a wrongly swept photograph is recoverable.
    const res = await call('DELETE', urlFor(PHOTO_PREFIX + name));
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${name} -> ${res.status}`);
  }

  async function listPhotos() {
    const out = [];
    let token = '';
    do {
      const q = '?list-type=2&prefix=' + encodeURIComponent(`${prefix}${PHOTO_PREFIX}`) +
        '&max-keys=1000' + (token ? '&continuation-token=' + encodeURIComponent(token) : '');
      const res = await call('GET', bucketUrl(q));
      if (res.status === 403) throw denialAdvice('LIST', 'photos/', await res.text());
      if (!res.ok) throw new Error(`S3 LIST -> ${res.status} ${await res.text()}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(m[1])?.[1] || '';
        const when = /<LastModified>([^<]*)<\/LastModified>/.exec(m[1])?.[1];
        const name = key.slice(`${prefix}${PHOTO_PREFIX}`.length);
        if (name) out.push({ name, modified: when ? Date.parse(when) : Date.now() });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] || ''
        : '';
    } while (token);
    return out;
  }

  const where = cfg.endpoint
    ? `${cfg.endpoint}/${cfg.bucket}/${prefix}`
    : `s3://${cfg.bucket}/${prefix}`;
  return {
    read, write, readPhoto, writePhoto, deletePhoto, listPhotos,
    describe: () => where, kind: 's3',
  };
}

// --- selection --------------------------------------------------------------

/**
 * S3 when a bucket is named, the filesystem otherwise. Credentials are read
 * from the environment only — never from a file the repo could come to track.
 */
function createStore(env, root, photoDir) {
  if (!env.S3_BUCKET) return fileStore(root, photoDir);
  const missing = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`S3_BUCKET is set, so ${missing.join(' and ')} must be too`);
  }
  return s3Store({
    bucket: env.S3_BUCKET,
    prefix: env.S3_PREFIX || '',
    region: env.AWS_REGION || 'us-east-1',
    endpoint: env.S3_ENDPOINT || '',
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN || '',
  });
}

module.exports = {
  createStore, StoreConflict, KEYS, PHOTO_PREFIX, serialize, sign, escapePath,
};
