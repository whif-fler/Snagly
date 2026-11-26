'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneCache } = require('../packages/media/thumbnails');

test('thumbnail cache pruning removes oldest files and leaves unrelated files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagly-thumbs-'));
  try {
    const names = ['a', 'b', 'c'].map((char) => `${char.repeat(64)}.jpg`);
    names.forEach((name, index) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.alloc(100));
      const time = new Date(Date.now() - (3 - index) * 1000);
      fs.utimesSync(file, time, time);
    });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');

    const removed = pruneCache(dir, 150);
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(path.join(dir, names[0])), false);
    assert.equal(fs.existsSync(path.join(dir, names[1])), false);
    assert.equal(fs.existsSync(path.join(dir, names[2])), true);
    assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);

    assert.equal(pruneCache(dir, 1024), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
