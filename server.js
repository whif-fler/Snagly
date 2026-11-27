'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');
const engine = require('./engine');
const { parseYouTubeUrl, parseThumbnailUrl, isPathInside, safeJsonParse } = require('./lib/util');

const PORT = Number(process.env.REEL_PORT) || 4173;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'apps', 'web', 'public');
const MAX_BODY_BYTES = 2_000_000;
const THUMB_DIR = path.join(engine.dataDir(), 'cache', 'thumbs');
const MAX_THUMB_BYTES = 5 * 1024 * 1024;

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
  '.woff2': 'font/woff2'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  securityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendImage(res, file, ext) {
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Thumbnail unavailable' });
    securityHeaders(res);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'image/jpeg',
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=86400'
    });
    res.end(data);
  });
}

const IMAGE_EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

function findCachedThumb(key) {
  for (const ext of IMAGE_EXTENSIONS) {
    const file = path.join(THUMB_DIR, `${key}${ext}`);
    try {
      if (fs.existsSync(file)) return { file, ext };
    } catch {
      /* try the next extension */
    }
  }
  return null;
}

async function serveThumb(req, res, raw) {
  const url = parseThumbnailUrl(raw);
  if (!url) return sendJson(res, 400, { error: 'Unsupported thumbnail URL' });

  const key = createHash('sha256').update(url.toString()).digest('hex');
  const cached = findCachedThumb(key);
  if (cached) return sendImage(res, cached.file, cached.ext);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // redirect:'error' prevents an allowed host from bouncing the request to
    // an internal address after the hostname check above.
    const upstream = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { 'User-Agent': 'Snagly/1.1 (local playlist downloader)' }
    });
    if (!upstream.ok) return sendJson(res, 404, { error: 'Thumbnail unavailable' });
    const type = String(upstream.headers.get('content-type') || '')
      .toLowerCase()
      .split(';')[0]
      .trim();
    const ext = IMAGE_EXT_BY_TYPE[type];
    if (!ext) return sendJson(res, 404, { error: 'Not an image' });
    if (Number(upstream.headers.get('content-length') || 0) > MAX_THUMB_BYTES) {
      return sendJson(res, 404, { error: 'Image too large' });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > MAX_THUMB_BYTES) {
      return sendJson(res, 404, { error: 'Image too large' });
    }
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    const file = path.join(THUMB_DIR, `${key}${ext}`);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
    return sendImage(res, file, ext);
  } catch {
    return sendJson(res, 404, { error: 'Thumbnail unavailable' });
  } finally {
    clearTimeout(timer);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        finish({});
      }
    });
    req.on('end', () => finish(safeJsonParse(body, {})));
    req.on('error', () => finish({}));
  });
}

function originAllowed(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ALLOWED_HOSTS.has(url.host.toLowerCase());
  } catch {
    return false;
  }
}

// Blocks DNS-rebinding (Host header), cross-site form/fetch requests (Origin),
// and non-JSON bodies that a plain HTML form could send.
function guard(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    sendJson(res, 403, { error: 'Forbidden host' });
    return false;
  }
  if (!originAllowed(req.headers.origin)) {
    sendJson(res, 403, { error: 'Forbidden origin' });
    return false;
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    sendJson(res, 403, { error: 'Forbidden site' });
    return false;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const length = Number(req.headers['content-length'] || 0);
    const type = String(req.headers['content-type'] || '').toLowerCase();
    // Empty bodies are fine (DELETE, cache clear). Anything with content must be
    // JSON so a plain HTML form cannot forge a state-changing request.
    if (length > 0 && !type.startsWith('application/json')) {
      sendJson(res, 415, { error: 'Expected application/json' });
      return false;
    }
    if (length > MAX_BODY_BYTES) {
      sendJson(res, 413, { error: 'Request body is too large' });
      return false;
    }
  }
  return true;
}

const buckets = new Map();
function rateLimit(req, res, name, limit, windowMs) {
  const ip = req.socket.remoteAddress || 'local';
  const key = `${name}:${ip}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > limit) {
    sendJson(res, 429, { error: 'Too many requests. Wait a moment and try again.' });
    return false;
  }
  return true;
}
setInterval(
  () => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.start > 60 * 60 * 1000) buckets.delete(key);
    }
  },
  60 * 60 * 1000
).unref();

function youtubeLinks(values) {
  const urls = [];
  const invalid = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;
    const url = parseYouTubeUrl(text);
    if (url) urls.push(url.toString());
    else invalid.push(text.slice(0, 120));
  }
  return { urls, invalid };
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad path' });
  }
  if (relative === '/') relative = 'index.html';
  else relative = relative.replace(/^\/+/, '');
  if (relative === 'privacy') relative = 'privacy.html';
  if (relative.includes('\0')) return sendJson(res, 400, { error: 'Bad path' });

  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!isPathInside(PUBLIC_DIR, filePath)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    securityHeaders(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': relative.startsWith('assets/') ? 'public, max-age=3600' : 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
}

function openPath(target, reveal, res) {
  if (!target || typeof target !== 'string' || target.length > 4096) {
    return sendJson(res, 400, { error: 'No path given' });
  }
  const resolved = path.resolve(target);
  if (!engine.isLibraryPath(resolved)) {
    return sendJson(res, 403, { error: 'Path is outside the library' });
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return sendJson(res, 404, { error: 'Path does not exist' });
  }

  const args = reveal && stat.isFile() ? ['/select,', resolved] : [resolved];
  const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => console.error('Could not open Explorer:', err.message));
  child.unref();
  return sendJson(res, 200, { ok: true });
}

const FOLDER_PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose where Snagly saves music'
$dialog.ShowNewFolderButton = $true
if ($env:SNAGLY_INITIAL -and (Test-Path -LiteralPath $env:SNAGLY_INITIAL)) {
  $dialog.SelectedPath = $env:SNAGLY_INITIAL
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;

function pickFolder(current, res) {
  const initial = typeof current === 'string' ? current.trim() : '';
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-STA', '-NonInteractive', '-Command', FOLDER_PICKER_SCRIPT],
    {
      windowsHide: true,
      env: { ...process.env, SNAGLY_INITIAL: initial },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let stdout = '';
  let stderr = '';
  let responded = false;
  const reply = (payload) => {
    if (responded) return;
    responded = true;
    sendJson(res, 200, payload);
  };
  const fail = (message) => {
    if (responded) return;
    responded = true;
    sendJson(res, 500, { error: message });
  };

  const timer = setTimeout(
    () => {
      try {
        child.kill();
      } catch {}
      reply({ path: null, error: 'The folder picker timed out' });
    },
    5 * 60 * 1000
  );

  child.stdout.on('data', (chunk) => {
    if (stdout.length < 4096) stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 4096) stderr += chunk.toString();
  });
  child.on('error', (err) => {
    clearTimeout(timer);
    fail(err.message);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const chosen = stdout.trim();
    if (code === 0 && chosen) return reply({ path: chosen });
    if (code !== 0 && stderr.trim()) return fail(stderr.trim().slice(-400));
    return reply({ path: null });
  });
}

const server = http.createServer(async (req, res) => {
  if (!guard(req, res)) return;

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/thumb') {
    if (!rateLimit(req, res, 'thumb', 600, 60_000)) return;
    return serveThumb(req, res, url.searchParams.get('u'));
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    securityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    engine.addSSE(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    return sendJson(res, 200, engine.getStatus());
  }

  // The shared frontend probes /api/session to tell local from cloud. Answering
  // it here keeps the browser console clean and lets privacy.js pick the right
  // policy without logging a 404 first.
  if (req.method === 'GET' && pathname === '/api/session') {
    return sendJson(res, 200, {
      capabilities: {
        mode: 'local',
        localFolderPicker: true,
        fileSystemAccess: false,
        serverTagEditing: true
      }
    });
  }

  if (req.method === 'GET' && pathname === '/api/connections') {
    if (!rateLimit(req, res, 'connections', 30, 60_000)) return;
    try {
      return sendJson(
        res,
        200,
        await engine.connectionReport({ refresh: url.searchParams.get('refresh') === '1' })
      );
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    try {
      engine.reconcileLibrary();
      return sendJson(res, 200, {
        jobs: engine.publicJobs(),
        status: engine.getStatus()
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/preview') {
    if (!rateLimit(req, res, 'preview', 20, 60_000)) return;
    const body = await readBody(req);
    const raw = Array.isArray(body.urls) ? body.urls : [body.url];
    if (raw.length > 50) return sendJson(res, 400, { error: 'Too many links at once' });
    const { urls, invalid } = youtubeLinks(raw);
    if (invalid.length) return sendJson(res, 400, { error: 'Only YouTube links are supported' });
    if (!urls.length) return sendJson(res, 400, { error: 'Paste at least one YouTube link' });
    try {
      return sendJson(res, 200, await engine.previewSources(urls));
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/probe') {
    if (!rateLimit(req, res, 'probe', 60, 60_000)) return;
    const body = await readBody(req);
    const parsed = parseYouTubeUrl(String(body.url || '').trim());
    if (!parsed) return sendJson(res, 400, { error: 'A YouTube link is required' });
    try {
      return sendJson(res, 200, { formats: await engine.probeFormats(parsed.toString()) });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    if (!rateLimit(req, res, 'jobs', 20, 60_000)) return;
    const body = await readBody(req);
    const rawItems = Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.urls)
        ? body.urls
        : [body.url];
    if (rawItems.length > 50) return sendJson(res, 400, { error: 'Too many links at once' });

    const items = [];
    let invalid = false;
    for (const item of rawItems) {
      const object = typeof item === 'string' ? { url: item } : item;
      const parsed = parseYouTubeUrl(String(object?.url || '').trim());
      if (!parsed) {
        invalid = true;
        continue;
      }
      const selected = Array.isArray(object?.selected)
        ? object.selected
            .slice(0, 5000)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= 100000)
        : null;
      items.push({ url: parsed.toString(), selected });
    }
    if (invalid) return sendJson(res, 400, { error: 'Only YouTube links are supported' });
    if (!items.length) return sendJson(res, 400, { error: 'Paste at least one YouTube link' });

    const isVideo = Boolean(body.isVideo);
    const format = String(body.format || (isVideo ? '1080p' : 'mp3'));
    const validFormats = new Set((isVideo ? engine.videoFormats() : engine.formats()).map((f) => f.key));
    if (!validFormats.has(format)) return sendJson(res, 400, { error: 'Unknown quality option' });

    if (body.root !== undefined) {
      try {
        engine.prepareRoot(body.root);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    try {
      const result = await engine.createJobs(items, {
        root: body.root,
        collection: body.collection,
        format,
        isVideo,
        allowDuplicate: Boolean(body.allowDuplicate)
      });
      return sendJson(res, 201, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname.startsWith('/api/jobs/') && pathname.endsWith('/retry')) {
    if (!rateLimit(req, res, 'retry', 30, 60_000)) return;
    const id = pathname.split('/')[3];
    const body = await readBody(req);
    const trackId = body.trackId ? String(body.trackId) : null;
    if (trackId && !/^[A-Za-z0-9_-]{11}$/.test(trackId)) {
      return sendJson(res, 400, { error: 'Invalid track id' });
    }
    try {
      const count = engine.retryJob(id, trackId);
      if (count === false) return sendJson(res, 404, { error: 'Job not found' });
      return sendJson(res, 200, { retried: count });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/jobs/')) {
    const id = pathname.split('/')[3];
    // Local only: ?files=1 removes the media this job wrote before dropping the
    // library entry. The cloud API never accepts this option.
    const deleteFiles = new URL(req.url, 'http://127.0.0.1').searchParams.get('files') === '1';
    try {
      let deleted = null;
      if (deleteFiles) {
        deleted = engine.deleteJobFiles(id);
        if (deleted.error === 'missing') return sendJson(res, 404, { error: 'Job not found' });
        if (deleted.error === 'running')
          return sendJson(res, 409, { error: 'Job is still downloading. Cancel it first' });
        if (deleted.errors.length) {
          return sendJson(res, 500, {
            error: `Could not delete ${deleted.errors.length} file${deleted.errors.length === 1 ? '' : 's'}: ${deleted.errors[0]}`
          });
        }
      }
      const result = engine.removeJob(id);
      if (result === 'missing') return sendJson(res, 404, { error: 'Job not found' });
      if (result === 'running')
        return sendJson(res, 409, { error: 'Job is still downloading. Cancel it first' });
      return sendJson(res, 200, { ok: true, removedFiles: deleted?.removedFiles ?? 0 });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname.startsWith('/api/jobs/') && pathname.endsWith('/cancel')) {
    const id = pathname.split('/')[3];
    try {
      const count = engine.cancelJob(id);
      if (count === false) return sendJson(res, 404, { error: 'Job not found' });
      return sendJson(res, 200, { cancelled: count });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/history') {
    try {
      return sendJson(res, 200, { history: engine.getHistory() });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/cache/clear') {
    try {
      const removed = engine.clearCache();
      return sendJson(res, 200, { removed });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/pause') {
    const body = await readBody(req);
    engine.setPaused(Boolean(body.paused));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(req);
    if (body.workers !== undefined) engine.setWorkers(body.workers);
    if (body.isVideo !== undefined) engine.setIsVideo(Boolean(body.isVideo));
    if (body.root !== undefined) {
      try {
        engine.setRoot(body.root);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    return sendJson(res, 200, engine.getStatus());
  }

  if (req.method === 'POST' && pathname === '/api/open') {
    if (!rateLimit(req, res, 'open', 60, 60_000)) return;
    const body = await readBody(req);
    return openPath(body.path, Boolean(body.reveal), res);
  }

  if (req.method === 'POST' && pathname === '/api/browse') {
    if (!rateLimit(req, res, 'browse', 10, 60_000)) return;
    const body = await readBody(req);
    return pickFolder(body.path, res);
  }

  if (req.method === 'GET' && pathname === '/api/formats') {
    return sendJson(res, 200, { formats: engine.formats() });
  }

  if (req.method === 'GET' && pathname === '/api/video-formats') {
    return sendJson(res, 200, { formats: engine.videoFormats() });
  }

  if (req.method === 'POST' && pathname === '/api/tags/edit') {
    if (!rateLimit(req, res, 'tags', 30, 60_000)) return;
    const body = await readBody(req);
    const file = body.file;
    const tags = body.tags;
    if (typeof file !== 'string' || !file || !tags || typeof tags !== 'object' || Array.isArray(tags)) {
      return sendJson(res, 400, { error: 'File and tags required' });
    }
    try {
      await engine.editTags(file, tags);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      const status = /outside the library|Only media|not found/i.test(err.message) ? 400 : 500;
      return sendJson(res, status, { error: err.message });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  return sendJson(res, 405, { error: 'Method not allowed' });
});

server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Close the other Snagly window, or start with: $env:REEL_PORT = 5000; node server.js\n`);
    process.exit(1);
  }
  throw err;
});

engine.init();
server.listen(PORT, HOST, () => {
  console.log(`\n  Snagly is running at http://localhost:${PORT}`);
  console.log(`  Library root: ${engine.getStatus().root}`);
  console.log('  Press Ctrl+C to stop.\n');
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    engine.shutdown();
  } catch (err) {
    console.error('Shutdown error:', err.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
