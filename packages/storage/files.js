'use strict';

const fs = require('fs');
const path = require('path');
const { sanitizeFilename, sanitizeFolder, isMediaFile } = require('../core');
const { ensureDir, safeResolve, statSize } = require('../platform/fs');

/**
 * Every user gets a private root. Paths are always built from server-owned ids,
 * never from a request-supplied path, so traversal and symlink-style escapes
 * have nothing to attach to.
 */
function createFileStore({ downloadDir }) {
  ensureDir(downloadDir);

  const userDir = (userId) => {
    if (!/^usr_[A-Za-z0-9_-]{8,}$/.test(String(userId || ''))) throw new Error('Invalid user id');
    return safeResolve(downloadDir, userId);
  };
  const jobDir = (userId, jobId) => {
    if (!/^job_[A-Za-z0-9_-]{8,}$/.test(String(jobId || ''))) throw new Error('Invalid job id');
    return safeResolve(userDir(userId), jobId);
  };
  const trackFile = (userId, jobId, filename) => {
    const name = sanitizeFilename(filename, 'track');
    if (!isMediaFile(name)) throw new Error('Not a media file');
    return safeResolve(jobDir(userId, jobId), name);
  };

  return {
    root: downloadDir,
    userDir,
    jobDir,
    trackFile,
    ensureJob(userId, jobId) {
      const dir = jobDir(userId, jobId);
      ensureDir(dir);
      return dir;
    },
    prepareUser(userId) {
      return ensureDir(userDir(userId));
    },
    filename(title, index, ext) {
      const safeExt = /^\.[a-z0-9]{1,8}$/i.test(ext || '') ? ext.toLowerCase() : '';
      const base = sanitizeFolder(title || `Track ${index}`, `Track ${index}`, 140);
      return `${String(index).padStart(2, '0')} - ${base}${safeExt}`;
    },
    jobFile(userId, jobId, filename) {
      const file = trackFile(userId, jobId, filename);
      if (!fs.existsSync(file)) return null;
      const stat = fs.statSync(file);
      return stat.isFile() ? { file, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    },
    listJobFiles(userId, jobId, tracks = []) {
      const out = [];
      for (const track of tracks) {
        if (!track.filename) continue;
        const found = this.jobFile(userId, jobId, track.filename);
        if (found) out.push({ ...found, name: track.filename, track });
      }
      return out;
    },
    removeJob(userId, jobId) {
      const dir = jobDir(userId, jobId);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    jobBytes(userId, jobId) {
      const dir = jobDir(userId, jobId);
      let total = 0;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile()) total += statSize(path.join(dir, entry.name));
        }
      } catch {}
      return total;
    }
  };
}

module.exports = { createFileStore };
