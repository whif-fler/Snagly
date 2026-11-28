'use strict';

const { sanitizeFolder } = require('../core');
const { createMockAdapter, createYtDlpAdapter } = require('./adapters');

function createAdapter(config, { logger, tools } = {}) {
  if (config.engine === 'mock') return createMockAdapter();
  return createYtDlpAdapter({
    ytdlpPath: tools?.yt || config.ytdlpPath,
    ffmpegPath: tools?.ffmpeg || config.ffmpegPath,
    cookiesFile: config.cookiesFile || '',
    logger,
    maxDurationMs: config.maxDurationMs
  });
}

function trackFilename(track, ext) {
  const base = sanitizeFolder(track.title || `Track ${track.idx}`, `Track ${track.idx}`, 140);
  const suffix = String(track.idx).padStart(2, '0');
  const cleanExt = /^\.[a-z0-9]{1,8}$/i.test(ext || '') ? ext.toLowerCase() : '.bin';
  return `${suffix} - ${base}${cleanExt}`;
}

module.exports = { createAdapter, trackFilename, createMockAdapter, createYtDlpAdapter };
