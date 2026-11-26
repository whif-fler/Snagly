'use strict';

const { parseCookies, serializeCookie } = require('./cookies');
const { sendError } = require('./delivery');
const { getSession, createSession } = require('../../../../packages/storage/sessions');

const SESSION_COOKIE = 'snagly_sid';

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type !== 'application/json') {
      const err = new Error('Content-Type must be application/json');
      err.status = 415;
      return reject(err);
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      const err = new Error('Compressed request bodies are not supported');
      err.status = 415;
      return reject(err);
    }
    let total = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        chunks.length = 0;
        const err = new Error('Request body is too large');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!total) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, val) => {
          if (key === '__proto__' || key === 'prototype') return undefined;
          return val;
        });
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          const err = new Error('JSON body must be an object');
          err.status = 400;
          return reject(err);
        }
        resolve(value);
      } catch {
        const err = new Error('Invalid JSON body');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function createSessionRoutes({ db, config, security }) {
  function sessionFromRequest(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return token ? getSession(db, token) : null;
  }

  function setSessionCookie(res, token) {
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, token, {
        maxAge: Math.floor(config.sessionTtlMs / 1000),
        secure: config.secureCookies,
        sameSite: 'Lax'
      })
    );
  }

  function bootstrap(req, res, jobs) {
    if (!security.rateLimit(req, res, 'session', 60, 60_000)) return;
    let session = sessionFromRequest(req);
    if (!session) {
      const created = createSession(db, { ttlMs: config.sessionTtlMs });
      session = { userId: created.userId, csrfToken: created.csrfToken, expiresAt: created.expiresAt };
      setSessionCookie(res, created.token);
    }
    sendJson(res, 200, {
      apiVersion: config.apiVersion,
      user: { id: session.userId },
      csrfToken: session.csrfToken,
      capabilities: jobs.capabilities(),
      retentionHours: Math.round(config.retentionMs / 3_600_000),
      limits: {
        globalConcurrency: config.globalConcurrency,
        perUserConcurrency: config.perUserConcurrency,
        maxPlaylistEntries: config.maxPlaylistEntries,
        maxLinksPerRequest: config.maxLinksPerRequest,
        maxFileMb: Math.round(config.maxFileBytes / 1024 / 1024)
      }
    });
  }

  function requireSession(req, res) {
    const session = sessionFromRequest(req);
    if (!session) {
      sendError(res, 401, 'Session required', security);
      return null;
    }
    return session;
  }

  return {
    readJsonBody,
    sendJson,
    sessionFromRequest,
    setSessionCookie,
    bootstrap,
    requireSession,
    SESSION_COOKIE
  };
}

module.exports = { createSessionRoutes, readJsonBody, sendJson, SESSION_COOKIE };
