'use strict';

const fs = require('fs');
const path = require('path');
const { sanitizeTags } = require('../core');
const { runProcess } = require('../platform/process');

/**
 * Rewrite metadata by remuxing the stream with FFmpeg (`-c copy`), then replace
 * the original atomically. The file path comes from server-owned storage, never
 * from a request path.
 */
async function writeTags({ ffmpegPath, file, tags, timeoutMs = 60_000 }) {
  if (!ffmpegPath) throw new Error('FFmpeg is not available');
  if (!fs.existsSync(file)) throw new Error('File not found');
  const clean = sanitizeTags(tags);
  if (!clean || !Object.keys(clean).length) throw new Error('No supported tags supplied');
  const ext = path.extname(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file, ext)}.${process.pid}.tagged${ext}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy'];
  for (const [key, value] of Object.entries(clean)) {
    args.push('-metadata', `${key}=${value}`);
  }
  args.push(temp);
  try {
    await runProcess(ffmpegPath, args, { timeoutMs });
    if (!fs.existsSync(temp) || fs.statSync(temp).size === 0) throw new Error('FFmpeg produced no output');
    fs.renameSync(temp, file);
    return clean;
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {}
  }
}

module.exports = { writeTags };
