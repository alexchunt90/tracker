#!/usr/bin/env node
/*
 * The lint the project can afford: every JavaScript file the repo tracks is
 * parsed by the runtime it will run on, so a syntax slip that only one
 * browser would have tripped over is caught before it is pushed.
 *
 * No linter is installed because nothing is installed — the README opens by
 * saying so. If a fuller pass is ever wanted, this is the script to grow.
 *
 *   node scripts/lint.js
 */
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '--', '*.js'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  // The widgets run in Scriptable on a phone, against its own globals.
  .filter((f) => !f.startsWith('widgets/'));

let failed = 0;
for (const file of files) {
  const out = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
  if (out.status !== 0) {
    failed++;
    process.stderr.write(out.stderr || `${file}: failed to parse\n`);
  }
}
console.log(failed ? `${failed} of ${files.length} files failed to parse` : `${files.length} files parse`);
process.exit(failed ? 1 : 0);
