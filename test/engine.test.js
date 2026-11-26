'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../engine');

const { sanitizeFolder, findTrackFile, findExisting, parseExtraction, prepareRoot, FORMATS, VIDEO_FORMATS } = engine._test;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagly-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sanitizeFolder removes characters Windows cannot use', () => {
  assert.equal(sanitizeFolder('AC/DC: Live?'), 'ACDC Live');
  assert.equal(sanitizeFolder('  Mix  '), 'Mix');
  assert.equal(sanitizeFolder('...'), 'Playlist');
  assert.equal(sanitizeFolder(''), 'Playlist');
});

test('MP3 preset asks for CBR 320, not VBR V0', () => {
  assert.deepEqual(FORMATS.mp3.args, ['-x', '--audio-format', 'mp3', '--audio-quality', '320K']);
  assert.deepEqual(FORMATS.mp3v0.args, ['-x', '--audio-format', 'mp3', '--audio-quality', 'V0']);
});

test('video presets are ceilings, not exact matches', () => {
  assert.ok(VIDEO_FORMATS['2160p'].args.join(' ').includes('height<=2160'));
  assert.ok(VIDEO_FORMATS['1080p'].args.join(' ').includes('height<=1080'));
});

test('findTrackFile resolves a "best" download with any media extension', t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, '01 - Song.webm'), 'x');
  assert.equal(findTrackFile(dir, 1, 2, false, '', ''), '01 - Song.webm');
  assert.equal(findExisting(dir, 1, 2, ''), '01 - Song.webm');
});

test('findTrackFile ignores partial downloads', t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, '01 - Song.mp3.part'), 'x');
  fs.writeFileSync(path.join(dir, '01 - Song.mp3'), 'x');
  assert.equal(findExisting(dir, 1, 2, '.mp3'), '01 - Song.mp3');
});

test('findTrackFile finds a single video by its bracketed id', t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'A title [dQw4w9WgXcQ].mp4'), 'x');
  assert.equal(findTrackFile(dir, 1, 2, true, 'dQw4w9WgXcQ', '.mp4'), 'A title [dQw4w9WgXcQ].mp4');
});

test('parseExtraction reads a playlist payload and drops invalid video ids', () => {
  const payload = {
    id: 'PL123',
    title: 'My Playlist',
    entries: [
      { id: 'dQw4w9WgXcQ', title: 'One', playlist_index: 1, channel: 'Artist' },
      { id: 'short', title: 'Bad', playlist_index: 2 },
      { id: 'jNQXAC9IVRw', title: 'Two', playlist_index: 3 }
    ]
  };
  const parsed = parseExtraction(JSON.stringify(payload));
  assert.equal(parsed.title, 'My Playlist');
  assert.equal(parsed.single, false);
  assert.deepEqual(parsed.entries.map(e => e.id), ['dQw4w9WgXcQ', 'jNQXAC9IVRw']);
  assert.equal(parsed.entries[0].artist, 'Artist');
});

test('parseExtraction marks a single video', () => {
  const payload = { id: 'dQw4w9WgXcQ', title: 'A video', formats: [] };
  const parsed = parseExtraction(JSON.stringify(payload));
  assert.equal(parsed.single, true);
  assert.equal(parsed.originalTitle, 'A video');
  assert.equal(parsed.entries.length, 1);
});

test('parseExtraction reports malformed output instead of throwing', () => {
  const parsed = parseExtraction('not json');
  assert.match(parsed.error, /Could not read playlist metadata/);
});

test('prepareRoot rejects relative paths', () => {
  assert.throws(() => prepareRoot('Music'), /absolute path/);
  assert.throws(() => prepareRoot(''), /required/);
});

test('prepareRoot creates and accepts an absolute directory', t => {
  const dir = path.join(tempDir(t), 'nested', 'library');
  assert.equal(prepareRoot(dir), path.normalize(dir));
  assert.equal(fs.existsSync(dir), true);
});
