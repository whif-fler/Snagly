'use strict';

const { sanitizeFolder } = require('../core');

function tokenUrl(signer, payload, baseTtl, jobExpiresAt) {
  if (!signer) return null;
  let ttl = baseTtl;
  if (jobExpiresAt) ttl = Math.min(ttl, Date.parse(jobExpiresAt) - Date.now());
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return signer.sign(payload, ttl);
}

/**
 * Map database rows to the versioned public contract. Server filesystem paths
 * are never included. Delivery URLs are HMAC-signed and expire with the job.
 */
function serializeJob({ job, tracks }, { signer, config } = {}) {
  const counts = { done: 0, failed: 0, cancelled: 0, missing: 0, running: 0, queued: 0 };
  for (const track of tracks) {
    if (Object.hasOwn(counts, track.status)) counts[track.status]++;
  }
  const expired = Boolean(job.expires_at && Date.parse(job.expires_at) <= Date.now());
  const baseTtl = config.downloadTokenTtlMs;
  const archiveToken =
    !expired && counts.done > 0
      ? tokenUrl(signer, { u: job.user_id, j: job.id }, baseTtl, job.expires_at)
      : null;

  return {
    id: job.id,
    url: job.source_url,
    sourceUrl: job.source_url,
    playlistId: job.playlist_id || '',
    title: job.title,
    thumb: job.thumb || null,
    folderName: job.folder_name,
    folder: null,
    albumTag: job.collection || job.title,
    status: job.status,
    single: Boolean(job.single),
    isVideo: Boolean(job.is_video),
    format: job.format,
    trackCount: tracks.length,
    done: counts.done,
    failed: counts.failed,
    cancelled: counts.cancelled,
    missing: counts.missing,
    running: counts.running,
    queued: counts.queued,
    createdAt: job.created_at,
    finishedAt: job.finished_at || null,
    expiresAt: job.expires_at || null,
    expired,
    totalBytes: job.total_bytes || 0,
    archiveUrl: archiveToken ? `/api/jobs/${job.id}/archive?token=${encodeURIComponent(archiveToken)}` : null,
    tracks: tracks.map((track) => {
      const downloadToken =
        track.status === 'done' && track.filename && !expired
          ? tokenUrl(signer, { u: job.user_id, j: job.id, t: track.id }, baseTtl, job.expires_at)
          : null;
      return {
        id: track.id,
        index: track.idx,
        videoId: track.video_id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        status: track.status,
        phase: track.phase || null,
        progress: Math.max(0, Math.min(100, Number(track.progress) || 0)),
        speed: track.speed || '',
        eta: Number.isFinite(track.eta) ? track.eta : null,
        size: Number(track.size) || 0,
        filename: track.filename || null,
        file: null,
        error: track.error || null,
        warning: track.warning || null,
        completedAt: track.completed_at || null,
        downloadUrl: downloadToken
          ? `/api/jobs/${job.id}/files/${track.id}?token=${encodeURIComponent(downloadToken)}`
          : null
      };
    })
  };
}

function serializeJobList(rows, options) {
  return rows.map((row) => serializeJob(row, options));
}

function safeFolderName(value, fallback) {
  return sanitizeFolder(value || fallback || 'Playlist', 'Playlist', 120);
}

module.exports = { serializeJob, serializeJobList, safeFolderName };
