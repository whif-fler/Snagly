'use strict';

const path = require('path');

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

const MEDIA_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.aac', '.flac', '.opus', '.ogg', '.oga', '.wav',
  '.webm', '.mp4', '.mkv', '.mov', '.m4v'
]);

// Hosts that YouTube serves cover art from. The local server fetches only from
// these names so a thumbnail URL cannot be used for SSRF.
const THUMBNAIL_HOSTS = new Set([
  'i.ytimg.com',
  'img.youtube.com',
  'i9.ytimg.com',
  'yt3.ggpht.com',
  'yt3.googleusercontent.com',
  'lh3.googleusercontent.com'
]);

const ALLOWED_TAG_KEYS = new Set([
  'title', 'artist', 'album', 'album artist', 'date', 'genre', 'comment', 'track'
]);

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

function isPathInside(parent, child) {
  if (!parent || !child) return false;
  const normalise = p => {
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
    out[name] = String(value).replace(/[\r\n\u0000]/g, ' ').trim().slice(0, 512);
  }
  return out;
}

function isMediaFile(file) {
  return MEDIA_EXTENSIONS.has(path.extname(String(file || '')).toLowerCase());
}

// Returns the parsed URL only when it is a plain https image URL on an
// allow-listed YouTube host. Anything else (credentials, odd ports, lookalike
// hosts) is rejected before the server makes a network request.
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

module.exports = {
  YOUTUBE_HOSTS,
  THUMBNAIL_HOSTS,
  MEDIA_EXTENSIONS,
  ALLOWED_TAG_KEYS,
  parseYouTubeUrl,
  isYouTubeUrl,
  parseThumbnailUrl,
  isPathInside,
  escapeRegExp,
  safeJsonParse,
  sanitizeTags,
  isMediaFile
};
