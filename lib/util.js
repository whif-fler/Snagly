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

module.exports = {
  YOUTUBE_HOSTS,
  MEDIA_EXTENSIONS,
  ALLOWED_TAG_KEYS,
  parseYouTubeUrl,
  isYouTubeUrl,
  isPathInside,
  escapeRegExp,
  safeJsonParse,
  sanitizeTags,
  isMediaFile
};
