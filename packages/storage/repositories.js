'use strict';

const { transaction } = require('./db');

const TRACK_FIELDS = new Set([
  'status',
  'phase',
  'progress',
  'speed',
  'eta',
  'size',
  'filename',
  'error',
  'warning',
  'attempts',
  'started_at',
  'completed_at',
  'title',
  'artist',
  'album'
]);

const nowIso = () => new Date().toISOString();

function insertJob(db, job, tracks) {
  transaction(db, () => {
    db.prepare(
      `
      INSERT INTO jobs (
        id, user_id, source_url, playlist_key, playlist_id, title, thumb,
        folder_name, status, single, is_video, format, collection,
        created_at, finished_at, expires_at, error, total_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `
    ).run(
      job.id,
      job.userId,
      job.sourceUrl,
      job.playlistKey,
      job.playlistId || '',
      job.title,
      job.thumb || null,
      job.folderName,
      job.status || 'queued',
      job.single ? 1 : 0,
      job.isVideo ? 1 : 0,
      job.format,
      job.collection || '',
      job.createdAt || nowIso(),
      null,
      null,
      null
    );
    const stmt = db.prepare(`
      INSERT INTO tracks (
        id, job_id, user_id, idx, video_id, title, artist, album, status,
        phase, progress, speed, eta, size, filename, error, warning, attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, '', NULL, 0, NULL, NULL, NULL, 0)
    `);
    for (const track of tracks) {
      stmt.run(
        track.id,
        job.id,
        job.userId,
        track.index,
        track.videoId,
        track.title,
        track.artist || '',
        track.album || ''
      );
    }
  });
}

function countJobs(db, userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?').get(userId).n;
}

function countQueuedTracks(db, userId) {
  return db
    .prepare(
      `
    SELECT COUNT(*) AS n FROM tracks t JOIN jobs j ON j.id = t.job_id
    WHERE t.user_id = ? AND t.status IN ('queued', 'running') AND j.expires_at IS NULL
  `
    )
    .get(userId).n;
}

function findDuplicate(db, userId, playlistKey) {
  return (
    db
      .prepare(
        `
    SELECT id FROM jobs
    WHERE user_id = ? AND playlist_key = ? AND expires_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `
      )
      .get(userId, playlistKey) || null
  );
}

function getJobsWithTracks(db, userId, { limit = 200 } = {}) {
  const jobs = db
    .prepare(
      `
    SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `
    )
    .all(userId, Math.max(1, Math.min(1000, Number(limit) || 200)));
  if (!jobs.length) return [];
  const ids = jobs.map((job) => job.id);
  const placeholders = ids.map(() => '?').join(',');
  const tracks = db
    .prepare(
      `
    SELECT * FROM tracks WHERE job_id IN (${placeholders}) ORDER BY idx ASC
  `
    )
    .all(...ids);
  const byJob = new Map(jobs.map((job) => [job.id, []]));
  for (const track of tracks) byJob.get(track.job_id)?.push(track);
  return jobs.map((job) => ({ job, tracks: byJob.get(job.id) || [] }));
}

function getJob(db, userId, jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
  if (!job) return null;
  const tracks = db.prepare('SELECT * FROM tracks WHERE job_id = ? ORDER BY idx ASC').all(jobId);
  return { job, tracks };
}

function getJobById(db, jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  return { job, tracks: db.prepare('SELECT * FROM tracks WHERE job_id = ? ORDER BY idx ASC').all(jobId) };
}

function getTrack(db, userId, jobId, trackId) {
  return (
    db
      .prepare(
        `
    SELECT t.* FROM tracks t JOIN jobs j ON j.id = t.job_id
    WHERE t.id = ? AND t.job_id = ? AND t.user_id = ?
  `
      )
      .get(trackId, jobId, userId) || null
  );
}

function updateTrack(db, trackId, fields) {
  const entries = Object.entries(fields).filter(([key]) => TRACK_FIELDS.has(key));
  if (!entries.length) return false;
  const sql = `UPDATE tracks SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
  return db.prepare(sql).run(...entries.map(([, value]) => value), trackId).changes > 0;
}

function updateTrackIfStatus(db, trackId, status, fields) {
  const entries = Object.entries(fields).filter(([key]) => TRACK_FIELDS.has(key));
  if (!entries.length) return false;
  const sql = `UPDATE tracks SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ? AND status = ?`;
  return db.prepare(sql).run(...entries.map(([, value]) => value), trackId, status).changes > 0;
}

function nextQueuedTrack(db, userId) {
  return (
    db
      .prepare(
        `
    SELECT t.*, j.is_video, j.format AS job_format, j.folder_name
    FROM tracks t JOIN jobs j ON j.id = t.job_id
    WHERE t.user_id = ? AND t.status = 'queued' AND j.expires_at IS NULL
    ORDER BY j.created_at ASC, t.idx ASC LIMIT 1
  `
      )
      .get(userId) || null
  );
}

function claimTrack(db, trackId, startedAt = nowIso()) {
  return (
    db
      .prepare(
        `
    UPDATE tracks SET status = 'running', phase = 'preparing', progress = 0,
      started_at = ?, attempts = attempts + 1, error = NULL
    WHERE id = ? AND status = 'queued'
  `
      )
      .run(startedAt, trackId).changes === 1
  );
}

function refreshJob(db, jobId, retentionMs) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, missing: 0 };
  let totalBytes = 0;
  for (const row of db.prepare('SELECT status, size FROM tracks WHERE job_id = ?').all(jobId)) {
    if (Object.hasOwn(counts, row.status)) counts[row.status]++;
    if (row.status === 'done') totalBytes += Number(row.size) || 0;
  }
  const total = Object.values(counts).reduce((n, v) => n + v, 0);
  let status;
  if (counts.queued > 0 || counts.running > 0) {
    status =
      counts.running > 0 || job.finished_at ? 'running' : job.status === 'queued' ? 'queued' : 'running';
  } else if (counts.done === total && total > 0) {
    status = 'done';
  } else if (counts.done > 0) {
    status = 'partial';
  } else if (counts.cancelled > 0) {
    status = 'cancelled';
  } else {
    status = 'failed';
  }
  const terminal = counts.queued === 0 && counts.running === 0;
  const finishedAt = terminal ? job.finished_at || nowIso() : null;
  const expiresAt = terminal ? new Date(Date.parse(finishedAt) + retentionMs).toISOString() : null;
  db.prepare(
    `
    UPDATE jobs SET status = ?, finished_at = ?, expires_at = ?, total_bytes = ?
    WHERE id = ?
  `
  ).run(status, finishedAt, expiresAt, totalBytes, jobId);
  return { ...job, status, finished_at: finishedAt, expires_at: expiresAt, total_bytes: totalBytes, counts };
}

function cancelJob(db, userId, jobId) {
  const job = db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
  if (!job) return null;
  const changed = db
    .prepare(
      `
    UPDATE tracks SET status = 'cancelled', phase = NULL, speed = '', eta = NULL, error = 'Cancelled'
    WHERE job_id = ? AND status = 'queued'
  `
    )
    .run(jobId).changes;
  return { queuedCancelled: changed };
}

function retryJob(db, userId, jobId, trackId = '') {
  const job = db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
  if (!job) return false;
  const retryable = "status IN ('failed', 'cancelled', 'missing')";
  const changed = trackId
    ? db
        .prepare(
          `
        UPDATE tracks SET status = 'queued', phase = NULL, progress = 0, speed = '',
          eta = NULL, size = 0, filename = NULL, error = NULL, warning = NULL,
          started_at = NULL, completed_at = NULL
        WHERE id = ? AND job_id = ? AND ${retryable}
      `
        )
        .run(trackId, jobId).changes
    : db
        .prepare(
          `
        UPDATE tracks SET status = 'queued', phase = NULL, progress = 0, speed = '',
          eta = NULL, size = 0, filename = NULL, error = NULL, warning = NULL,
          started_at = NULL, completed_at = NULL
        WHERE job_id = ? AND ${retryable}
      `
        )
        .run(jobId).changes;
  if (changed) {
    db.prepare(
      "UPDATE jobs SET status = 'queued', finished_at = NULL, expires_at = NULL, error = NULL WHERE id = ?"
    ).run(jobId);
  }
  return changed;
}

function removeJob(db, userId, jobId) {
  const job = db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
  if (!job) return 'missing';
  const active = db
    .prepare("SELECT COUNT(*) AS n FROM tracks WHERE job_id = ? AND status IN ('queued', 'running')")
    .get(jobId).n;
  if (active) return 'running';
  db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  return 'removed';
}

function recoverInterrupted(db) {
  const tracks = db
    .prepare(
      "UPDATE tracks SET status = 'queued', phase = NULL, speed = '', eta = NULL WHERE status = 'running'"
    )
    .run().changes;
  const jobs = db
    .prepare(
      "UPDATE jobs SET status = 'queued', finished_at = NULL, expires_at = NULL WHERE status = 'running'"
    )
    .run().changes;
  return { tracks, jobs };
}

function expiredJobs(db, now = new Date()) {
  return db
    .prepare(
      `
    SELECT id, user_id FROM jobs
    WHERE expires_at IS NOT NULL AND expires_at <= ?
  `
    )
    .all(now.toISOString());
}

function deleteExpiredJob(db, userId, jobId) {
  return db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').run(jobId, userId).changes > 0;
}

function activeTrackCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE status = 'running'").get().n;
}

function queuedUsers(db) {
  return db
    .prepare(
      `
    SELECT t.user_id, COUNT(*) AS n
    FROM tracks t JOIN jobs j ON j.id = t.job_id
    WHERE t.status = 'queued' AND j.expires_at IS NULL
    GROUP BY t.user_id
  `
    )
    .all();
}

function queueDepth(db, userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE user_id = ? AND status = 'queued'").get(userId).n;
}

module.exports = {
  insertJob,
  countJobs,
  countQueuedTracks,
  findDuplicate,
  getJobsWithTracks,
  getJob,
  getJobById,
  getTrack,
  updateTrack,
  updateTrackIfStatus,
  nextQueuedTrack,
  claimTrack,
  refreshJob,
  cancelJob,
  retryJob,
  removeJob,
  recoverInterrupted,
  expiredJobs,
  deleteExpiredJob,
  activeTrackCount,
  queuedUsers,
  queueDepth
};
