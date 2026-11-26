'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  parseYouTubeUrl,
  parseThumbnailUrl,
  isPathInside,
  escapeRegExp,
  safeJsonParse,
  sanitizeTags,
  isMediaFile
} = require('../lib/util');

test('parseYouTubeUrl accepts real YouTube links', () => {
  const links = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://music.youtube.com/playlist?list=PL123',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'http://youtube.com/playlist?list=PL123&si=abc'
  ];
  for (const link of links) {
    assert.ok(parseYouTubeUrl(link), `expected ${link} to be accepted`);
  }
});

test('parseYouTubeUrl rejects lookalikes and non-web schemes', () => {
  const links = [
    'https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    'https://evil.com/?next=youtu.be/dQw4w9WgXcQ',
    'javascript:alert(1)',
    'file:///C:/Windows/win.ini',
    'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com:8080/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/' + 'a'.repeat(3000)
  ];
  for (const link of links) {
    assert.equal(parseYouTubeUrl(link), null, `expected ${link} to be rejected`);
  }
  assert.equal(parseYouTubeUrl(''), null);
  assert.equal(parseYouTubeUrl(null), null);
});

test('isPathInside only allows descendants', () => {
  const root = path.join('C:', 'Users', 'you', 'Music');
  assert.equal(isPathInside(root, path.join(root, 'Album', '01.mp3')), true);
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, path.join('C:', 'Users', 'you', 'Music2', 'x.mp3')), false);
  assert.equal(isPathInside(root, path.join('C:', 'Windows', 'win.ini')), false);
});

test('escapeRegExp escapes every regex metacharacter', () => {
  const nasty = 'a.b*c+d?e^f$g{h}i(j)k[l]m\\n|o';
  const regex = new RegExp(`^${escapeRegExp(nasty)}$`);
  assert.equal(regex.test(nasty), true);
  assert.equal(regex.test('aXbXcXdXeXfXgXhXiXjXkXlXmXnXo'), false);
});

test('safeJsonParse drops prototype-pollution keys', () => {
  const parsed = safeJsonParse('{"__proto__":{"polluted":true},"constructor":{"x":1},"ok":2}');
  assert.equal(parsed.ok, 2);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(parsed, '__proto__'), false);
  assert.equal(Object.hasOwn(parsed, 'constructor'), false);
});

test('safeJsonParse returns a fallback for malformed input', () => {
  assert.deepEqual(safeJsonParse('{nope', { fallback: true }), { fallback: true });
});

test('sanitizeTags keeps only allow-listed keys and strips newlines', () => {
  const tags = sanitizeTags({
    title: 'A\nTitle',
    artist: 'Artist',
    album: 'Album',
    evil: 'nope',
    __proto__: 'polluted',
    comment: 42
  });
  assert.deepEqual(tags, {
    title: 'A Title',
    artist: 'Artist',
    album: 'Album',
    comment: '42'
  });
  assert.equal(sanitizeTags('nope'), null);
  assert.equal(sanitizeTags([]), null);
});

test('isMediaFile only accepts known audio/video extensions', () => {
  assert.equal(isMediaFile('C:\\Music\\01 - Song.mp3'), true);
  assert.equal(isMediaFile('C:\\Music\\video.MP4'), true);
  assert.equal(isMediaFile('C:\\Music\\notes.txt'), false);
  assert.equal(isMediaFile(''), false);
});

test('parseThumbnailUrl accepts only plain https YouTube image hosts', () => {
  const good = [
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    'https://yt3.ggpht.com/abc=w1200-h1200'
  ];
  for (const url of good) {
    assert.ok(parseThumbnailUrl(url), `expected ${url} to be accepted`);
  }

  const bad = [
    'http://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    'https://i.ytimg.com.evil.com/a.jpg',
    'https://evil.com/i.ytimg.com/a.jpg',
    'https://i.ytimg.com:8443/a.jpg',
    'https://user:pass@i.ytimg.com/a.jpg',
    'https://localhost/a.jpg',
    'https://127.0.0.1/a.jpg',
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'https://i.ytimg.com/' + 'a'.repeat(2100)
  ];
  for (const url of bad) {
    assert.equal(parseThumbnailUrl(url), null, `expected ${url} to be rejected`);
  }
  assert.equal(parseThumbnailUrl(''), null);
  assert.equal(parseThumbnailUrl(null), null);
});
