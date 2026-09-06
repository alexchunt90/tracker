'use strict';

/* ---------------------------------------------------------------------------
 * The .env file, read the one way.
 *
 * Node 18 has no --env-file, and three entry points — the server and the two
 * scripts — each want the same handful of variables. One parser, so a rule
 * about quoting or precedence cannot drift between them.
 * ------------------------------------------------------------------------- */

const fs = require('node:fs');

/**
 * Load KEY=value lines from `file` into `env`, which is process.env unless a
 * test says otherwise.
 *
 * A missing file is fine. The real environment always wins: a key already
 * set is left alone, so `PORT=5000 node server.js` beats whatever the file
 * says. Blank lines and # comments are skipped, and a value wrapped in
 * matching quotes has them stripped.
 */
function loadEnv(file, env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return env;
    throw err;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in env) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

module.exports = { loadEnv };
