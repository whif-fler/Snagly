'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../packages/config');
const { openDatabase } = require('../packages/storage/db');
const { createSession, insertJob } = require('../packages/storage');
const { createFileStore } = require('../packages/storage/files');
const { Scheduler } = require('../packages/download-engine/scheduler');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagly-sched-'));
  const config = {
    ...loadConfig({
      SNAGLY_DATA_DIR: dataDir,
      SNAGLY_MEDIA_ENGINE: 'mock',
      SNAGLY_DOWNLOAD_SECRET: 'scheduler-secret-0123456789abcdef',
      SNAGLY_LOG_LEVEL: 'error'
    }),
    ...overrides
  };
  const db = openDatabase(':memory:');
  const files = createFileStore({ downloadDir: config.downloadDir });
  const users = [createSession(db, { ttlMs: 60_000 }), createSession(db, { ttlMs: 60_000 })];
  const logger = { warn() {}, error() {}, info() {}, debug() {} };
  return { dataDir, config, db, files, users, logger };
}

function addJob(db, userId, { jobId, tracks = 2, status = 'queued' }) {
  const rows = Array.from({ length: tracks }, (_, i) => ({
    id: `trk_${jobId}-${String(i).padStart(4, '0')}`,
    index: i + 1,
    videoId: `vid${String(i).padStart(8, '0')}`,
    title: `Track ${i + 1}`,
    artist: 'Artist',
    album: 'Album'
  }));
  insertJob(
    db,
    {
      id: jobId,
      userId,
      sourceUrl: 'https://www.youtube.com/playlist?list=PL123',
      playlistKey: `pl:${jobId}`,
      playlistId: 'PL123',
      title: 'Playlist',
      thumb: null,
      folderName: 'Playlist',
      status,
      single: false,
      isVideo: false,
      format: 'mp3',
      collection: '',
      createdAt: new Date().toISOString()
    },
    rows
  );
  return rows;
}

function fileAdapter({ delayMs = 40, onStart, onEnd } = {}) {
  return {
    name: 'test',
    async download({ track, dir, filename }, { signal, onProgress } = {}) {
      onStart?.(track);
      try {
        onProgress?.({ progress: 50, speed: '1MiB/s', eta: 1, phase: 'downloading' });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(Object.assign(new Error('Cancelled'), { aborted: true }));
            },
            { once: true }
          );
        });
        const name = filename(track, '.mp3');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), Buffer.from('audio'));
        return { filename: name, size: 5 };
      } finally {
        onEnd?.(track);
      }
    }
  };
}

async function waitUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error('Timed out');
}

test('scheduler enforces global and per-user concurrency', async () => {
  const { dataDir, config, db, files, users, logger } = setup({
    globalConcurrency: 2,
    perUserConcurrency: 1
  });
  let active = 0;
  let maxGlobal = 0;
  const perUser = new Map();
  let maxPerUser = 0;
  const scheduler = new Scheduler({
    db,
    files,
    config,
    logger,
    adapter: fileAdapter({
      delayMs: 50,
      onStart(track) {
        active++;
        maxGlobal = Math.max(maxGlobal, active);
        const n = (perUser.get(track.user_id) || 0) + 1;
        perUser.set(track.user_id, n);
        maxPerUser = Math.max(maxPerUser, n);
      },
      onEnd(track) {
        active--;
        perUser.set(track.user_id, (perUser.get(track.user_id) || 1) - 1);
      }
    })
  });

  addJob(db, users[0].userId, { jobId: 'job_aaaaaaaa-1111-1111-1111-111111111111', tracks: 3 });
  addJob(db, users[1].userId, { jobId: 'job_bbbbbbbb-1111-1111-1111-111111111111', tracks: 3 });
  scheduler.start();
  try {
    await waitUntil(() => db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE status = 'done'").get().n === 6);
    assert.ok(maxGlobal <= 2, `global concurrency exceeded: ${maxGlobal}`);
    assert.ok(maxPerUser <= 1, `per-user concurrency exceeded: ${maxPerUser}`);
  } finally {
    await scheduler.stop();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('cancelling a job aborts running work and cancels queued tracks', async () => {
  const { dataDir, config, db, files, users, logger } = setup({
    globalConcurrency: 3,
    perUserConcurrency: 2
  });
  const scheduler = new Scheduler({
    db,
    files,
    config,
    logger,
    adapter: fileAdapter({ delayMs: 500 })
  });
  const jobId = 'job_cccccccc-1111-1111-1111-111111111111';
  addJob(db, users[0].userId, { jobId, tracks: 3 });
  scheduler.start();
  try {
    await waitUntil(
      () => db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE status = 'running'").get().n > 0
    );
    const result = scheduler.cancelJob(users[0].userId, jobId);
    assert.ok(result.cancelled >= 2);
    await waitUntil(
      () => db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE status = 'running'").get().n === 0
    );
    const statuses = db
      .prepare('SELECT status FROM tracks WHERE job_id = ?')
      .all(jobId)
      .map((r) => r.status);
    assert.deepEqual(statuses, ['cancelled', 'cancelled', 'cancelled']);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status, 'cancelled');
  } finally {
    await scheduler.stop();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a worker timeout marks the track failed rather than hanging', async () => {
  const { dataDir, config, db, files, users, logger } = setup({
    globalConcurrency: 1,
    perUserConcurrency: 1,
    maxDurationMs: 60
  });
  const scheduler = new Scheduler({
    db,
    files,
    config,
    logger,
    adapter: fileAdapter({ delayMs: 1000 })
  });
  const jobId = 'job_dddddddd-1111-1111-1111-111111111111';
  addJob(db, users[0].userId, { jobId, tracks: 1 });
  scheduler.start();
  try {
    await waitUntil(
      () => db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE status IN ('failed', 'done')").get().n === 1,
      3000
    );
    const track = db.prepare('SELECT * FROM tracks WHERE job_id = ?').get(jobId);
    assert.equal(track.status, 'failed');
    assert.match(track.error, /timed out/i);
  } finally {
    await scheduler.stop();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('cleanup removes expired files and records but not active jobs', async () => {
  const { dataDir, config, db, files, users, logger } = setup();
  const jobId = 'job_eeeeeeee-1111-1111-1111-111111111111';
  const tracks = addJob(db, users[0].userId, { jobId, tracks: 1, status: 'done' });
  const dir = files.ensureJob(users[0].userId, jobId);
  const name = files.filename('Track', 1, '.mp3');
  fs.writeFileSync(path.join(dir, name), 'audio');
  db.prepare("UPDATE tracks SET status = 'done', filename = ?, size = 5 WHERE id = ?").run(
    name,
    tracks[0].id
  );
  db.prepare('UPDATE jobs SET status = ?, expires_at = ? WHERE id = ?').run(
    'done',
    new Date(Date.now() - 1000).toISOString(),
    jobId
  );

  const scheduler = new Scheduler({ db, files, config, logger, adapter: fileAdapter() });
  const result = scheduler.cleanup();
  assert.equal(result.removed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE id = ?').get(jobId).n, 0);
  assert.equal(fs.existsSync(dir), false);
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
