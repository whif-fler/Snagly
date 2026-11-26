'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isPathInside } = require('../core');

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}

function atomicWrite(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, data, { mode });
  fs.renameSync(temp, file);
}

function readOrCreateSecret(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value.length >= 32) return value;
  } catch {}
  const value = crypto.randomBytes(32).toString('base64url');
  atomicWrite(file, value, 0o600);
  return value;
}

function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function safeResolve(root, ...segments) {
  const target = path.resolve(root, ...segments);
  if (!isPathInside(root, target)) throw new Error('Path escapes the storage root');
  return target;
}

module.exports = { ensureDir, atomicWrite, readOrCreateSecret, statSize, safeResolve };
