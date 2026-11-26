'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOTS = ['apps/server', 'packages', 'scripts', 'test', 'tests'];
const SKIP = new Set(['node_modules', '.git', 'data', 'coverage', 'dist']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}

for (const root of ROOTS) {
  if (fs.existsSync(root)) walk(root);
}
for (const file of ['server.js', 'engine.js', 'lib/util.js']) {
  if (fs.existsSync(file)) files.push(file);
}
if (fs.existsSync('apps/web/public')) {
  walk('apps/web/public');
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`Syntax error: ${file}`);
    if (err.stderr) console.error(err.stderr.toString());
  }
}
console.log(`Checked ${files.length} JavaScript files.`);
process.exit(failed ? 1 : 0);
