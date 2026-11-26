'use strict';

const path = require('path');
const { randomBytes, randomUUID } = require('crypto');

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com'
]);

// Hosts that YouTube serves cover art from. The server fetches only from these
// names so a thumbnail URL cannot be used for SSRF.
const THUMBNAIL_HOSTS = new Set([
  'i.ytimg.com',
  'img.youtube.com',
  'i9.ytimg.com',
  'yt3.ggpht.com',
  'yt3.googleusercontent.com',
  'lh3.googleusercontent.com'
]);

const MEDIA_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.opus',
  '.ogg',
  '.oga',
  '.wav',
  '.webm',
  '.mp4',
  '.mkv',
  '.mov',
  '.m4v'
]);

const ALLOWED_TAG_KEYS = new Set([
  'title',
  'artist',
  'album',
  'album artist',
  'date',
  'genre',
  'comment',
  'track'
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,100}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function parseYouTubeUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 2048) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '80' && url.port !== '443') return null;
  return url;
}

function isYouTubeUrl(value) {
  return Boolean(parseYouTubeUrl(value));
}

function videoIdFromUrl(value) {
  const url = parseYouTubeUrl(value);
  if (!url) return '';
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || '';
    return VIDEO_ID_RE.test(id) ? id : '';
  }
  const v = url.searchParams.get('v');
  if (v && VIDEO_ID_RE.test(v)) return v;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
    return VIDEO_ID_RE.test(parts[1] || '') ? parts[1] : '';
  }
  return '';
}

function playlistIdFromUrl(value) {
  const url = parseYouTubeUrl(value);
  if (!url) return '';
  const id = url.searchParams.get('list') || '';
  return PLAYLIST_ID_RE.test(id) ? id : '';
}

function isSingleVideoUrl(value) {
  return Boolean(videoIdFromUrl(value)) && !playlistIdFromUrl(value);
}

function canonicalWatchUrl(videoId) {
  if (!VIDEO_ID_RE.test(String(videoId || ''))) throw new Error('Invalid video id');
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function parseThumbnailUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 2048) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (!THUMBNAIL_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  return url;
}

function isPathInside(parent, child) {
  if (!parent || !child) return false;
  const normalise = (p) => {
    const resolved = path.resolve(String(p));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const base = normalise(parent);
  const target = normalise(child);
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });
  } catch {
    return fallback;
  }
}

function sanitizeTags(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return null;
  const out = {};
  for (const [key, value] of Object.entries(tags)) {
    const name = String(key).toLowerCase();
    if (!ALLOWED_TAG_KEYS.has(name)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    out[name] = String(value)
      .replace(/[\r\n\u0000]/g, ' ')
      .trim()
      .slice(0, 512);
  }
  return out;
}

function isMediaFile(file) {
  return MEDIA_EXTENSIONS.has(path.extname(String(file || '')).toLowerCase());
}

// Folder names are used as path segments. Strip separators, control characters
// and Windows-reserved suffixes; never return '.' or '..'.
function sanitizeFolder(name, fallback = 'Playlist', maxLength = 120) {
  let cleaned = String(name ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .replace(/[. ]+$/g, '');
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

function sanitizeFilename(name, fallback = 'track', maxLength = 180) {
  // Split manually rather than with path.basename: on Windows a name like
  // "A:B.mp3" is treated as drive-relative and silently loses its first
  // character, which would change a user-visible title.
  const raw = String(name || '');
  const leaf = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  const dot = leaf.lastIndexOf('.');
  const ext = dot > 0 ? leaf.slice(dot).toLowerCase() : '';
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const base = sanitizeFolder(stem, fallback, maxLength - ext.length);
  return `${base || fallback}${MEDIA_EXTENSIONS.has(ext) ? ext : ''}`;
}

function parseSelection(selected, max = 10000) {
  if (!Array.isArray(selected) || !selected.length) return null;
  const out = new Set();
  for (const raw of selected) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) continue;
    out.add(n);
  }
  return out.size ? out : null;
}

function assertPositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function randomId(prefix, bytes = 12) {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

function jobId() {
  return `job_${randomUUID()}`;
}

function trackId() {
  return `trk_${randomUUID()}`;
}

function userId() {
  return `usr_${randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  YOUTUBE_HOSTS,
  THUMBNAIL_HOSTS,
  MEDIA_EXTENSIONS,
  ALLOWED_TAG_KEYS,
  VIDEO_ID_RE,
  PLAYLIST_ID_RE,
  parseYouTubeUrl,
  isYouTubeUrl,
  videoIdFromUrl,
  playlistIdFromUrl,
  isSingleVideoUrl,
  canonicalWatchUrl,
  parseThumbnailUrl,
  isPathInside,
  escapeRegExp,
  safeJsonParse,
  sanitizeTags,
  isMediaFile,
  sanitizeFolder,
  sanitizeFilename,
  parseSelection,
  assertPositiveInt,
  randomId,
  jobId,
  trackId,
  userId,
  nowIso
};

Object.assign(module.exports, require('./formats'));
