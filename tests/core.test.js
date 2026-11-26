'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeFolder,
  sanitizeFilename,
  parseSelection,
  isMediaFile,
  safeJsonParse,
  isKnownAudioFormat,
  isKnownVideoFormat,
  formatOptions
} = require('../packages/core');

test('sanitizeFolder removes path and control characters', () => {
  assert.equal(sanitizeFolder('A/B\\C:D*E?F"G<H>I|J'), 'ABCDEFGHIJ');
  assert.equal(sanitizeFolder('  ..  '), 'Playlist');
  assert.equal(sanitizeFolder(''), 'Playlist');
  assert.equal(sanitizeFolder('..hidden'), '..hidden');
  assert.equal(sanitizeFolder('name\u0000\u001f.mp3'), 'name.mp3');
  assert.equal(sanitizeFolder('A'.repeat(300), 'x', 20).length, 20);
});

test('sanitizeFolder avoids Windows reserved device names', () => {
  assert.equal(sanitizeFolder('CON'), '_CON');
  assert.equal(sanitizeFolder('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFolder('COM1'), '_COM1');
  assert.equal(sanitizeFolder('LPT9'), '_LPT9');
  assert.equal(sanitizeFolder('console'), 'console');
});

test('sanitizeFilename strips directories, normalises extensions and reserved names', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('A:B*C?.MP3'), 'ABC.mp3');
  assert.equal(sanitizeFilename('CON.mp3'), '_CON.mp3');
  assert.equal(sanitizeFilename('.. .mp3'), 'track.mp3');
  assert.equal(sanitizeFilename('Track.FLAC'), 'Track.flac');
  assert.equal(sanitizeFilename('Track.exe'), 'Track');
  assert.equal(sanitizeFilename('', 'fallback'), 'fallback');
  assert.ok(sanitizeFilename('x'.repeat(500) + '.mp3').length <= 180);
});

test('parseSelection keeps only valid 1-based indexes', () => {
  assert.deepEqual([...parseSelection([1, 2, 2, 3, 0, -1, 4.5, '5', 'x'], 5)].sort(), [1, 2, 3, 5]);
  assert.equal(parseSelection([], 5), null);
  assert.equal(parseSelection([0, -1, 99], 5), null);
  assert.equal(parseSelection('1-5', 5), null);
});

test('media extensions and format allow-lists are strict', () => {
  assert.equal(isMediaFile('Track.MP3'), true);
  assert.equal(isMediaFile('Track.exe'), false);
  assert.equal(isMediaFile('Track.mp3.exe'), false);
  assert.equal(isKnownAudioFormat('mp3'), true);
  assert.equal(isKnownAudioFormat('--exec=calc'), false);
  assert.equal(isKnownVideoFormat('1080p'), true);
  assert.equal(isKnownVideoFormat('9000p'), false);
  assert.ok(formatOptions('audio').some((option) => option.key === 'flac'));
  assert.ok(formatOptions('video').some((option) => option.key === '2160p'));
});

test('safeJsonParse drops prototype keys', () => {
  const value = safeJsonParse('{"a":1,"__proto__":{"polluted":true},"constructor":{"x":1}}');
  assert.equal(value.a, 1);
  assert.equal(Object.hasOwn(value, '__proto__'), false);
  assert.equal(Object.hasOwn(value, 'constructor'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(safeJsonParse('{bad'), null);
});
