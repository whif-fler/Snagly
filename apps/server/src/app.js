'use strict';

const path = require('path');
const { loadConfig } = require('../../../packages/config');
const { createLogger } = require('../../../packages/platform/logger');
const { detectTools } = require('../../../packages/platform/executables');
const { readOrCreateSecret } = require('../../../packages/platform/fs');
const { createSigner } = require('../../../packages/platform/signing');
const { openDatabase } = require('../../../packages/storage/db');
const { createFileStore } = require('../../../packages/storage/files');
const { createAdapter } = require('../../../packages/download-engine');
const { createMockAdapter } = require('../../../packages/download-engine/adapters');
const { Scheduler } = require('../../../packages/download-engine/scheduler');
const { createJobsService } = require('../../../packages/library/jobs');
const { SseHub } = require('./http/sse');

function createApp(config = loadConfig()) {
  const logger = createLogger({ level: config.logLevel });
  const db = openDatabase(config.dbFile);
  const files = createFileStore({ downloadDir: config.downloadDir });
  const tools = detectTools({ ytdlpPath: config.ytdlpPath, ffmpegPath: config.ffmpegPath });
  const adapter =
    config.engine === 'mock'
      ? createMockAdapter({ stepDelayMs: config.mockStepMs })
      : createAdapter(config, { logger, tools });
  const secret = config.downloadSecret || readOrCreateSecret(path.join(config.dataDir, '.download-secret'));
  const signer = createSigner(secret);
  const hub = new SseHub({ maxPerUser: config.maxSsePerUser });

  let jobs;
  const broadcastTimers = new Map();
  let closed = false;

  function broadcastNow(userId) {
    if (!jobs || closed) return;
    try {
      const snapshot = jobs.listJobs(userId);
      const settings = jobs.getSettings(userId);
      hub.publish(userId, {
        type: 'state',
        jobs: snapshot.jobs,
        paused: snapshot.status.paused,
        workers: snapshot.status.workers,
        active: snapshot.status.active,
        queued: snapshot.status.queued,
        penaltyMs: 0,
        isVideo: settings.isVideo
      });
    } catch (err) {
      logger.error('Broadcast failed', { error: err.message });
    }
  }

  function scheduleBroadcast(userId) {
    if (closed || broadcastTimers.has(userId)) return;
    const timer = setTimeout(() => {
      broadcastTimers.delete(userId);
      broadcastNow(userId);
    }, 250);
    timer.unref?.();
    broadcastTimers.set(userId, timer);
  }

  const scheduler = new Scheduler({
    db,
    adapter,
    files,
    config,
    logger,
    onChange: scheduleBroadcast,
    onCleanup: scheduleBroadcast
  });

  jobs = createJobsService({
    db,
    adapter,
    files,
    config,
    scheduler,
    signer,
    tools
  });

  function start() {
    scheduler.start();
    logger.info('Snagly cloud started', {
      mode: config.mode,
      engine: config.engine,
      dataDir: config.dataDir,
      host: config.host,
      port: config.port
    });
  }

  async function close() {
    closed = true;
    for (const timer of broadcastTimers.values()) clearTimeout(timer);
    broadcastTimers.clear();
    await scheduler.stop();
    hub.close();
    try {
      db.close();
    } catch {}
  }

  return {
    config,
    logger,
    db,
    files,
    tools,
    adapter,
    signer,
    hub,
    scheduler,
    jobs,
    signerSecret: secret,
    start,
    close,
    broadcastNow
  };
}

module.exports = { createApp };
