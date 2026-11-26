'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { loadConfig } = require('../packages/config');
const { createApp } = require('../apps/server/src/app');
const { createHttpServer } = require('../apps/server/src/http/server');

async function startTestServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagly-test-'));
  const config = loadConfig({
    SNAGLY_DATA_DIR: dataDir,
    SNAGLY_MEDIA_ENGINE: 'mock',
    SNAGLY_MOCK_STEP_MS: '2',
    SNAGLY_DOWNLOAD_SECRET: crypto.randomBytes(32).toString('base64url'),
    SNAGLY_LOG_LEVEL: 'error',
    SNAGLY_SECURE_COOKIES: 'false',
    SNAGLY_RETENTION_HOURS: '24',
    SNAGLY_MAX_BODY_BYTES: '4096',
    ...overrides
  });
  const app = createApp(config);
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  app.start();
  const base = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { app, server, config, base, dataDir, close };
}

class Session {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.csrfToken = '';
    this.userId = '';
  }

  async init() {
    const res = await fetch(`${this.base}/api/session`);
    if (res.status !== 200) throw new Error(`session failed: ${res.status}`);
    const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie') || '';
    this.cookie = setCookie.split(';')[0];
    const data = await res.json();
    this.csrfToken = data.csrfToken;
    this.userId = data.user.id;
    return data;
  }

  headers(extra = {}) {
    return { cookie: this.cookie, ...extra };
  }

  async get(pathname, options = {}) {
    return fetch(`${this.base}${pathname}`, {
      ...options,
      headers: this.headers(options.headers)
    });
  }

  async json(pathname, options = {}) {
    const res = await this.get(pathname, options);
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async send(method, pathname, body = {}) {
    return fetch(`${this.base}${pathname}`, {
      method,
      headers: this.headers({
        'content-type': 'application/json',
        'x-csrf-token': this.csrfToken
      }),
      body: JSON.stringify(body)
    });
  }

  async post(pathname, body = {}) {
    const res = await this.send('POST', pathname, body);
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async remove(pathname) {
    const res = await this.send('DELETE', pathname);
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }
}

async function newSession(base) {
  const session = new Session(base);
  await session.init();
  return session;
}

async function createJob(session, body = {}) {
  const { res, data } = await session.post('/api/jobs', {
    urls: ['https://www.youtube.com/playlist?list=PL1234567890'],
    format: 'mp3',
    ...body
  });
  if (res.status !== 201) throw new Error(`create job failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitForJob(
  session,
  jobId,
  predicate = (job) => job.status !== 'queued' && job.status !== 'running',
  timeoutMs = 10_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await session.json('/api/jobs');
    const job = (data.jobs || []).find((item) => item.id === jobId);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for job');
}

function rawRequest(base, { method = 'GET', path: requestPath = '/', headers = {} } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        path: requestPath,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function openSse(base, cookie) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: controller.signal
  });
  if (res.status !== 200) throw new Error(`SSE failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let finished = false;

  (async () => {
    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              // Ignore malformed frames; the client refreshes on reconnect.
            }
          }
        }
      }
    } catch {
      // Aborted by close().
    }
  })();

  async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for SSE event');
  }

  return {
    events,
    waitFor,
    close() {
      finished = true;
      controller.abort();
    }
  };
}

module.exports = { startTestServer, Session, newSession, createJob, waitForJob, rawRequest, openSse };
