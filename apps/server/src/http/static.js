'use strict';

const fs = require('fs');
const path = require('path');
const { isPathInside } = require('../../../../packages/core');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function createStatic({ webDir, security }) {
  return function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (decoded.includes('\0')) return false;
    let relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    if (relative === 'privacy') relative = 'privacy.html';
    if (!relative || relative.includes('..') || relative.split('/').some((part) => part.startsWith('.')))
      return false;
    const file = path.resolve(webDir, relative);
    if (!isPathInside(webDir, file)) return false;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext];
    if (!type) return false;
    security.headers(res);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'Last-Modified': stat.mtime.toUTCString()
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => {
      try {
        res.destroy();
      } catch {}
    });
    stream.pipe(res);
    return true;
  };
}

module.exports = { createStatic, MIME };
