'use strict';

const fs = require('fs');
const path = require('path');

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Find a binary without using a shell. The explicit path wins, then PATH.
 * This replaces Windows-only `where` lookups and keeps cloud images honest.
 */
function resolveExecutable(name, explicitPath = '', env = process.env) {
  if (explicitPath) {
    const candidate = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.resolve(process.cwd(), explicitPath);
    return isExecutable(candidate) ? candidate : '';
  }
  if (!name) return '';
  const names =
    process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(name) ? [`${name}.exe`, name] : [name];
  const dirs = String(env.PATH || env.Path || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return '';
}

function detectTools({ ytdlpPath = '', ffmpegPath = '', env = process.env } = {}) {
  const yt = resolveExecutable('yt-dlp', ytdlpPath, env);
  const ffmpeg = resolveExecutable('ffmpeg', ffmpegPath, env);
  return { yt, ffmpeg, ytDlp: yt };
}

module.exports = { resolveExecutable, detectTools, isExecutable };
