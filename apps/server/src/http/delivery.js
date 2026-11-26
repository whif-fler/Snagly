'use strict';

const fs = require('fs');
const path = require('path');
const { streamZip } = require('../../../../packages/storage/zip');

const MEDIA_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4'
};

function contentDisposition(filename) {
  const fallback =
    String(filename)
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\\r\n]/g, '_')
      .slice(0, 180) || 'download';
  const encoded = encodeURIComponent(String(filename).slice(0, 180)).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { invalid: true };
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) return { invalid: true };
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return { invalid: true };
  }
  return { start, end };
}

function sendError(res, status, message, security) {
  const body = JSON.stringify({ error: message });
  security.headers(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function streamFile(req, res, { file, size, filename, security }) {
  const type = MEDIA_MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream';
  const range = parseRange(req.headers.range, size);
  if (range?.invalid) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return sendError(res, 416, 'Invalid range', security);
  }

  security.headers(res);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (range) {
    res.writeHead(206, {
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': range.end - range.start + 1
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start: range.start, end: range.end });
    stream.on('error', () => {
      try {
        res.destroy();
      } catch {}
    });
    return stream.pipe(res);
  }

  res.writeHead(200, { 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {}
  });
  stream.pipe(res);
}

async function streamArchive(res, { entries, filename, security }) {
  security.headers(res);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition(filename),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  try {
    await streamZip(
      res,
      entries.map((entry) => ({
        name: entry.name,
        path: entry.file,
        size: entry.size,
        mtimeMs: entry.mtimeMs
      }))
    );
    res.end();
  } catch (err) {
    try {
      res.destroy();
    } catch {}
    if (err.message !== 'Client disconnected') throw err;
  }
}

module.exports = { streamFile, streamArchive, contentDisposition, parseRange, MEDIA_MIME, sendError };
