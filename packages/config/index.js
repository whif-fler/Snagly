'use strict';

const path = require('path');

function envBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function envInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid integer setting ${value}; expected ${min}..${max}`);
  }
  return n;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Load runtime configuration. All paths are absolute; all limits are numbers.
 * Cloud mode never enables native folder pickers.
 */
function loadConfig(env = process.env) {
  const mode = env.SNAGLY_MODE === 'local' ? 'local' : 'cloud';
  const dataDir = path.resolve(env.SNAGLY_DATA_DIR || path.join(process.cwd(), 'data', 'cloud'));
  const publicOrigin = String(env.SNAGLY_PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  let originHost = '';
  if (publicOrigin) {
    try {
      originHost = new URL(publicOrigin).host.toLowerCase();
    } catch {
      throw new Error('SNAGLY_PUBLIC_ORIGIN must be a valid origin such as https://snagly.example.com');
    }
  }

  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...splitList(env.SNAGLY_ALLOWED_HOSTS)]);
  if (originHost) allowedHosts.add(originHost);

  const port = envInt(env.PORT || env.SNAGLY_PORT, 4174, { min: 1, max: 65535 });
  const host = env.SNAGLY_HOST || '127.0.0.1';

  return Object.freeze({
    mode,
    host,
    port,
    publicOrigin,
    allowedHosts,
    trustProxy: envBool(env.SNAGLY_TRUST_PROXY, true),
    secureCookies: envBool(env.SNAGLY_SECURE_COOKIES, publicOrigin.startsWith('https://')),
    dataDir,
    dbFile: path.join(dataDir, 'snagly.sqlite'),
    downloadDir: path.join(dataDir, 'users'),
    thumbDir: path.join(dataDir, 'cache', 'thumbs'),
    webDir: path.resolve(env.SNAGLY_WEB_DIR || path.join(__dirname, '..', '..', 'apps', 'web', 'public')),
    engine: env.SNAGLY_MEDIA_ENGINE === 'mock' ? 'mock' : 'real',
    mockStepMs: envInt(env.SNAGLY_MOCK_STEP_MS, 25, { min: 0, max: 5000 }),
    ytdlpPath: env.SNAGLY_YTDLP_PATH || env.YTDLP_PATH || '',
    ffmpegPath: env.SNAGLY_FFMPEG_PATH || env.FFMPEG_PATH || '',
    sessionTtlMs: envInt(env.SNAGLY_SESSION_TTL_DAYS, 30, { min: 1, max: 365 }) * 24 * 60 * 60 * 1000,
    retentionMs: envInt(env.SNAGLY_RETENTION_HOURS, 24, { min: 1, max: 24 * 30 }) * 60 * 60 * 1000,
    cleanupIntervalMs: envInt(env.SNAGLY_CLEANUP_MINUTES, 10, { min: 1, max: 1440 }) * 60 * 1000,
    globalConcurrency: envInt(env.SNAGLY_GLOBAL_CONCURRENCY, 4, { min: 1, max: 32 }),
    perUserConcurrency: envInt(env.SNAGLY_USER_CONCURRENCY, 2, { min: 1, max: 16 }),
    maxPlaylistEntries: envInt(env.SNAGLY_MAX_PLAYLIST_ENTRIES, 500, { min: 1, max: 5000 }),
    maxTracksPerJob: envInt(env.SNAGLY_MAX_TRACKS_PER_JOB, 500, { min: 1, max: 5000 }),
    maxJobsPerUser: envInt(env.SNAGLY_MAX_JOBS_PER_USER, 100, { min: 1, max: 1000 }),
    maxQueuedTracksPerUser: envInt(env.SNAGLY_MAX_QUEUED_TRACKS, 300, { min: 1, max: 5000 }),
    maxFileBytes: envInt(env.SNAGLY_MAX_FILE_MB, 4096, { min: 1, max: 65536 }) * 1024 * 1024,
    maxJobBytes: envInt(env.SNAGLY_MAX_JOB_MB, 8192, { min: 1, max: 131072 }) * 1024 * 1024,
    maxDurationMs: envInt(env.SNAGLY_MAX_JOB_MINUTES, 30, { min: 1, max: 240 }) * 60 * 1000,
    maxBodyBytes: envInt(env.SNAGLY_MAX_BODY_BYTES, 64 * 1024, { min: 1024, max: 1024 * 1024 }),
    maxLinksPerRequest: envInt(env.SNAGLY_MAX_LINKS, 20, { min: 1, max: 100 }),
    previewCacheTtlMs: envInt(env.SNAGLY_PREVIEW_CACHE_MINUTES, 15, { min: 1, max: 240 }) * 60 * 1000,
    previewCacheMax: envInt(env.SNAGLY_PREVIEW_CACHE_ENTRIES, 500, { min: 50, max: 5000 }),
    thumbCacheBytes: envInt(env.SNAGLY_THUMB_CACHE_MB, 256, { min: 16, max: 4096 }) * 1024 * 1024,
    downloadTokenTtlMs: envInt(env.SNAGLY_DOWNLOAD_TOKEN_MINUTES, 10, { min: 1, max: 120 }) * 60 * 1000,
    downloadSecret: env.SNAGLY_DOWNLOAD_SECRET || '',
    maxSsePerUser: envInt(env.SNAGLY_MAX_SSE, 3, { min: 1, max: 20 }),
    logLevel: env.SNAGLY_LOG_LEVEL || 'info',
    version: '2.0.0',
    apiVersion: '1'
  });
}

module.exports = { loadConfig, envBool, envInt };
