'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseThumbnailUrl } = require('../core');
const { ensureDir } = require('../platform/fs');

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

/**
 * Fetch cover art server-side from an allow-listed YouTube image host and
 * cache it by URL hash. Redirects are refused, SVG is refused, and the body is
 * capped so a malicious response cannot exhaust memory or disk.
 */
async function fetchThumbnail(rawUrl, { cacheDir, fetchImpl = globalThis.fetch } = {}) {
  const url = parseThumbnailUrl(rawUrl);
  if (!url) {
    const err = new Error('Unsupported thumbnail URL');
    err.status = 400;
    throw err;
  }
  ensureDir(cacheDir);
  const key = crypto.createHash('sha256').update(url.toString()).digest('hex');
  for (const ext of Object.values(EXT_BY_TYPE)) {
    const cached = path.join(cacheDir, `${key}${ext}`);
    if (fs.existsSync(cached)) {
      return { file: cached, contentType: Object.keys(EXT_BY_TYPE).find((k) => EXT_BY_TYPE[k] === ext) };
    }
  }

  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif' }
    });
  } catch {
    const err = new Error('Thumbnail fetch failed');
    err.status = 502;
    throw err;
  }
  if (response.status !== 200) {
    const err = new Error('Thumbnail unavailable');
    err.status = 502;
    throw err;
  }
  const contentType = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!Object.hasOwn(EXT_BY_TYPE, contentType)) {
    const err = new Error('Unsupported thumbnail type');
    err.status = 415;
    throw err;
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) {
    const err = new Error('Thumbnail is too large');
    err.status = 413;
    throw err;
  }

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {}
      const err = new Error('Thumbnail is too large');
      err.status = 413;
      throw err;
    }
    chunks.push(Buffer.from(value));
  }

  const file = path.join(cacheDir, `${key}${EXT_BY_TYPE[contentType]}`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, Buffer.concat(chunks), { mode: 0o600 });
  fs.renameSync(temp, file);
  return { file, contentType };
}

module.exports = { fetchThumbnail, EXT_BY_TYPE, MAX_BYTES };
