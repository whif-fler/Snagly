'use strict';

const http = require('http');
const { API_VERSION } = require('../../../../packages/contracts');
const { createSecurity } = require('./security');
const { createSessionRoutes } = require('./session');
const { createStatic } = require('./static');
const { streamFile, streamArchive, sendError } = require('./delivery');
const { fetchThumbnail } = require('../../../../packages/media/thumbnails');
const { sanitizeTags, sanitizeFilename } = require('../../../../packages/core');
const { writeTags } = require('../../../../packages/media/tags');
const { getJobById } = require('../../../../packages/storage/repositories');
const { updateTrack } = require('../../../../packages/storage/repositories');
const { formatOptions } = require('../../../../packages/core/formats');

const JOB_ID = /^job_[A-Za-z0-9-]{8,80}$/;
const TRACK_ID = /^trk_[A-Za-z0-9-]{8,80}$/;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function createHttpServer(app) {
  const { config, logger, db, files, tools, signer, hub, jobs } = app;
  const security = createSecurity({ config });
  const sessions = createSessionRoutes({ db, config, security, jobs });
  const serveStatic = createStatic({ webDir: config.webDir, security });

  const server = http.createServer(async (req, res) => {
    security.headers(res);

    if (!security.hostAllowed(req)) {
      return sendError(res, 421, 'Host not allowed', security);
    }
    if (String(req.url || '').length > 4096) {
      return sendError(res, 414, 'Request URI too long', security);
    }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendError(res, 400, 'Bad request', security);
    }
    const pathname = url.pathname;

    try {
      if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        db.prepare('SELECT 1').get();
        return sessions.sendJson(res, 200, {
          ok: true,
          version: config.version,
          apiVersion: API_VERSION,
          engine: config.engine
        });
      }

      if (pathname === '/api/session' && req.method === 'GET') {
        return sessions.bootstrap(req, res, jobs);
      }

      // Signed delivery URLs are bearer capabilities scoped to one job/track and
      // a short TTL. They still work without a cookie, but never across users.
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        /^\/api\/jobs\/[^/]+\/(archive|files\/[^/]+)$/.test(pathname)
      ) {
        return await handleDelivery(req, res, url);
      }

      if (pathname.startsWith('/api/')) {
        const session = sessions.requireSession(req, res);
        if (!session) return;

        if (UNSAFE.has(req.method)) {
          if (req.headers['sec-fetch-site'] === 'cross-site') {
            return sendError(res, 403, 'Cross-site requests are not allowed', security);
          }
          if (!security.originAllowed(req)) {
            return sendError(res, 403, 'Origin not allowed', security);
          }
          if (String(req.headers['x-csrf-token'] || '') !== session.csrfToken) {
            return sendError(res, 403, 'Invalid CSRF token', security);
          }
        }
        if (!security.rateLimit(req, res, 'api', 600, 60_000, session.userId)) return;
        return await handleApi(req, res, url, session);
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (serveStatic(req, res, pathname)) return;
        return sendError(res, 404, 'Not found', security);
      }

      res.setHeader('Allow', 'GET, HEAD, POST, DELETE');
      return sendError(res, 405, 'Method not allowed', security);
    } catch (err) {
      const status = Number(err.status) || 500;
      if (status >= 500) {
        logger.error('Request failed', {
          method: req.method,
          path: pathname,
          error: err.message,
          stack: err.stack
        });
      }
      if (!res.headersSent)
        sendError(res, status, status >= 500 ? 'Internal server error' : err.message, security);
      else {
        try {
          res.destroy();
        } catch {}
      }
    }
  });

  async function handleDelivery(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const jobId = parts[2];
    const kind = parts[3];
    const trackId = parts[4] || '';
    if (!JOB_ID.test(jobId)) return sendError(res, 404, 'Not found', security);
    if (kind === 'files' && !TRACK_ID.test(trackId)) return sendError(res, 404, 'Not found', security);

    if (!security.rateLimit(req, res, 'download', 240, 60_000)) return;

    const token = url.searchParams.get('token');
    let payload = null;
    if (token) {
      payload = signer.verify(token);
      if (!payload || payload.j !== jobId)
        return sendError(res, 403, 'Invalid or expired download link', security);
      if (kind === 'files' && payload.t !== trackId)
        return sendError(res, 403, 'Invalid download link', security);
    }

    let session = null;
    if (!payload) {
      session = sessions.sessionFromRequest(req);
      if (!session) return sendError(res, 401, 'Session required', security);
    }
    const userId = payload ? payload.u : session.userId;

    const row = getJobById(db, jobId);
    if (!row || row.job.user_id !== userId) return sendError(res, 404, 'Job not found', security);
    if (row.job.expires_at && Date.parse(row.job.expires_at) <= Date.now()) {
      return sendError(res, 410, 'This download has expired', security);
    }

    if (kind === 'archive') {
      if (payload && payload.t) return sendError(res, 403, 'Invalid download link', security);
      const entries = files
        .listJobFiles(userId, jobId, row.tracks)
        .map((item) => ({ ...item, name: item.name }));
      if (!entries.length) return sendError(res, 404, 'No completed files to download', security);
      const total = entries.reduce((n, entry) => n + entry.size, 0);
      if (total > config.maxJobBytes) return sendError(res, 413, 'Archive is too large', security);
      const stem =
        sanitizeFilename(row.job.folder_name || 'snagly', 'snagly', 120).replace(/\.[^.]+$/, '') || 'snagly';
      return streamArchive(res, { entries, filename: `${stem}.zip`, security });
    }

    const track = row.tracks.find((item) => item.id === trackId);
    if (!track || track.status !== 'done' || !track.filename) {
      return sendError(res, 404, 'File not available', security);
    }
    const found = files.jobFile(userId, jobId, track.filename);
    if (!found) return sendError(res, 404, 'File not found', security);
    return streamFile(req, res, {
      file: found.file,
      size: found.size,
      filename: sanitizeFilename(track.filename, 'track'),
      security
    });
  }

  async function handleApi(req, res, url, session) {
    const { pathname, searchParams } = url;
    const userId = session.userId;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/config') {
      return sessions.sendJson(res, 200, {
        apiVersion: config.apiVersion,
        mode: config.mode,
        capabilities: jobs.capabilities(),
        retentionHours: Math.round(config.retentionMs / 3_600_000),
        limits: {
          maxPlaylistEntries: config.maxPlaylistEntries,
          maxLinksPerRequest: config.maxLinksPerRequest,
          maxFileMb: Math.round(config.maxFileBytes / 1024 / 1024),
          perUserConcurrency: config.perUserConcurrency
        }
      });
    }

    if (method === 'GET' && pathname === '/api/status') {
      return sessions.sendJson(res, 200, jobs.statusFor(userId));
    }

    if (method === 'GET' && pathname === '/api/events') {
      hub.add(userId, res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      app.broadcastNow(userId);
      return;
    }

    if (method === 'GET' && pathname === '/api/jobs') {
      return sessions.sendJson(res, 200, jobs.listJobs(userId));
    }

    if (method === 'GET' && pathname === '/api/history') {
      return sessions.sendJson(res, 200, { history: jobs.history(userId) });
    }

    if (method === 'GET' && pathname === '/api/formats') {
      return sessions.sendJson(res, 200, { formats: formatOptions('audio') });
    }

    if (method === 'GET' && pathname === '/api/video-formats') {
      return sessions.sendJson(res, 200, { formats: formatOptions('video') });
    }

    if (method === 'GET' && pathname === '/api/thumb') {
      if (!security.rateLimit(req, res, 'thumb', 600, 60_000, userId)) return;
      try {
        const thumb = await fetchThumbnail(searchParams.get('u'), { cacheDir: config.thumbDir });
        security.headers(res);
        res.setHeader('Content-Type', thumb.contentType);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        const data = require('fs').readFileSync(thumb.file);
        res.setHeader('Content-Length', data.length);
        return res.end(data);
      } catch (err) {
        return sendError(res, err.status || 502, err.message || 'Thumbnail unavailable', security);
      }
    }

    if (method === 'POST' && pathname === '/api/preview') {
      if (!security.rateLimit(req, res, 'preview', 30, 60_000, userId)) return;
      const body = await sessions.readJsonBody(req, config.maxBodyBytes);
      const urls = Array.isArray(body.urls) ? body.urls : [body.url];
      const result = await jobs.preview(userId, urls);
      return sessions.sendJson(res, 200, result);
    }

    if (method === 'POST' && pathname === '/api/probe') {
      if (!security.rateLimit(req, res, 'probe', 60, 60_000, userId)) return;
      const body = await sessions.readJsonBody(req, config.maxBodyBytes);
      const formats = await jobs.probe(body.url);
      return sessions.sendJson(res, 200, { formats });
    }

    if (method === 'POST' && pathname === '/api/jobs') {
      if (!security.rateLimit(req, res, 'create', 20, 60_000, userId)) return;
      const body = await sessions.readJsonBody(req, config.maxBodyBytes);
      const result = await jobs.createJobs(userId, body);
      return sessions.sendJson(res, 201, result);
    }

    const jobRoute = /^\/api\/jobs\/([^/]+)(?:\/(.*))?$/.exec(pathname);
    if (jobRoute) {
      const jobId = jobRoute[1];
      const rest = jobRoute[2] || '';
      if (!JOB_ID.test(jobId)) return sendError(res, 404, 'Job not found', security);

      if (method === 'GET' && !rest) {
        const job = jobs.getJob(userId, jobId);
        return job ? sessions.sendJson(res, 200, { job }) : sendError(res, 404, 'Job not found', security);
      }

      if (method === 'POST' && rest === 'cancel') {
        const result = jobs.cancel(userId, jobId);
        return result ? sessions.sendJson(res, 200, result) : sendError(res, 404, 'Job not found', security);
      }

      if (method === 'POST' && rest === 'retry') {
        if (!security.rateLimit(req, res, 'retry', 40, 60_000, userId)) return;
        const body = await sessions.readJsonBody(req, config.maxBodyBytes);
        const result = jobs.retry(userId, jobId, body.trackId ? String(body.trackId) : '');
        return result ? sessions.sendJson(res, 200, result) : sendError(res, 404, 'Job not found', security);
      }

      if (method === 'DELETE' && !rest) {
        const result = jobs.remove(userId, jobId);
        if (result === 'missing') return sendError(res, 404, 'Job not found', security);
        if (result === 'running') return sendError(res, 409, 'Job is still running', security);
        return sessions.sendJson(res, 200, { ok: true });
      }

      const tagMatch = /^tracks\/([^/]+)\/tags$/.exec(rest);
      if (method === 'POST' && tagMatch) {
        const trackId = tagMatch[1];
        if (!TRACK_ID.test(trackId)) return sendError(res, 404, 'Track not found', security);
        const body = await sessions.readJsonBody(req, config.maxBodyBytes);
        const tags = sanitizeTags(body.tags);
        if (!tags || !Object.keys(tags).length)
          return sendError(res, 400, 'No supported tags supplied', security);
        const row = app.db
          .prepare(
            `
          SELECT t.* FROM tracks t JOIN jobs j ON j.id = t.job_id
          WHERE t.id = ? AND t.job_id = ? AND t.user_id = ? AND t.status = 'done'
        `
          )
          .get(trackId, jobId, userId);
        if (!row || !row.filename) return sendError(res, 404, 'Track file not found', security);
        const found = files.jobFile(userId, jobId, row.filename);
        if (!found) return sendError(res, 404, 'Track file not found', security);
        if (config.engine !== 'mock') {
          if (!tools.ffmpeg)
            return sendError(res, 503, 'Tag editing is unavailable without FFmpeg', security);
          await writeTags({ ffmpegPath: tools.ffmpeg, file: found.file, tags, timeoutMs: 60_000 });
        }
        const updates = {};
        for (const key of ['title', 'artist', 'album']) if (tags[key] !== undefined) updates[key] = tags[key];
        if (Object.keys(updates).length) {
          updateTrack(app.db, trackId, updates);
        }
        app.broadcastNow(userId);
        return sessions.sendJson(res, 200, { ok: true, tags });
      }

      return sendError(res, 404, 'Not found', security);
    }

    if (method === 'POST' && pathname === '/api/pause') {
      const body = await sessions.readJsonBody(req, config.maxBodyBytes);
      const status = jobs.setPaused(userId, Boolean(body.paused));
      return sessions.sendJson(res, 200, status);
    }

    if (method === 'POST' && pathname === '/api/settings') {
      const body = await sessions.readJsonBody(req, config.maxBodyBytes);
      const status = jobs.updateSettings(userId, body);
      return sessions.sendJson(res, 200, status);
    }

    if (method === 'POST' && pathname === '/api/cache/clear') {
      return sessions.sendJson(res, 200, jobs.clearCache(userId));
    }

    if (
      method === 'POST' &&
      (pathname === '/api/open' || pathname === '/api/browse' || pathname === '/api/tags/edit')
    ) {
      return sendError(res, 403, 'This action is only available in the local desktop app', security);
    }

    return sendError(res, 404, 'Not found', security);
  }

  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return server;
}

module.exports = { createHttpServer };
