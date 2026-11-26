'use strict';

const {
  nextQueuedTrack,
  claimTrack,
  queuedUsers,
  updateTrack,
  updateTrackIfStatus,
  refreshJob,
  cancelJob,
  expiredJobs,
  deleteExpiredJob,
  getSetting
} = require('../storage');
const { trackFilename } = require('./index');

/**
 * In-process queue and worker pool. SQLite is the source of truth; the in-memory
 * map only tracks cancellation and concurrency for the current process. On
 * startup any interrupted track is put back in the queue.
 */
class Scheduler {
  constructor({ db, adapter, files, config, logger, onChange = () => {}, onCleanup = () => {} }) {
    this.db = db;
    this.adapter = adapter;
    this.files = files;
    this.config = config;
    this.logger = logger;
    this.onChange = onChange;
    this.onCleanup = onCleanup;
    this.active = new Map();
    this.pumpTimer = null;
    this.cleanupTimer = null;
    this.pumping = false;
    this.stopped = true;
    this.workerPromises = new Set();
  }

  start() {
    this.stopped = false;
    const recovered = require('../storage').recoverInterrupted(this.db);
    if (recovered.tracks) this.logger?.warn('Recovered interrupted tracks', recovered);
    this.pumpTimer = setInterval(() => this.pump(), 500);
    this.pumpTimer.unref?.();
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
    this.cleanup();
    this.pump();
  }

  async stop({ timeoutMs = 8000 } = {}) {
    this.stopped = true;
    clearInterval(this.pumpTimer);
    clearInterval(this.cleanupTimer);
    for (const entry of this.active.values()) entry.controller.abort();
    const pending = [...this.workerPromises];
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    }
  }

  notify() {
    if (!this.stopped) this.pump();
  }

  activeCount() {
    return this.active.size;
  }

  activeFor(userId) {
    let n = 0;
    for (const entry of this.active.values()) if (entry.userId === userId) n++;
    return n;
  }

  isJobActive(jobId) {
    for (const entry of this.active.values()) if (entry.jobId === jobId) return true;
    return false;
  }

  pump() {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.config.globalConcurrency) {
        let started = false;
        for (const { user_id: userId } of queuedUsers(this.db)) {
          if (this.activeFor(userId) >= this.config.perUserConcurrency) continue;
          if (getSetting(this.db, userId, 'paused', false)) continue;
          const track = nextQueuedTrack(this.db, userId);
          if (!track) continue;
          if (!claimTrack(this.db, track.id)) continue;
          this.startTrack(track);
          started = true;
          break;
        }
        if (!started) break;
      }
    } catch (err) {
      this.logger?.error('Scheduler pump failed', { error: err.message });
    } finally {
      this.pumping = false;
    }
  }

  startTrack(track) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(track.job_id);
    if (!job) return;
    const dir = this.files.ensureJob(job.user_id, job.id);
    const controller = new AbortController();
    const entry = {
      userId: job.user_id,
      jobId: job.id,
      controller,
      cancelRequested: false,
      timedOut: false,
      lastEmit: 0,
      lastProgressWrite: 0
    };
    this.active.set(track.id, entry);
    this.onChange(job.user_id, { active: true });

    const timeout = setTimeout(() => {
      entry.timedOut = true;
      this.logger?.warn('Track exceeded its time limit', { trackId: track.id });
      controller.abort();
    }, this.config.maxDurationMs);
    timeout.unref?.();

    const promise = (async () => {
      try {
        updateTrack(this.db, track.id, { phase: 'preparing', progress: 0, speed: '', eta: null });
        this.onChange(job.user_id);
        const result = await this.adapter.download(
          {
            track: { ...track, idx: track.idx },
            job,
            dir,
            filename: (t, ext) => trackFilename(t, ext)
          },
          {
            signal: controller.signal,
            onProgress: (progress) => {
              const now = Date.now();
              if (now - entry.lastProgressWrite > 500) {
                entry.lastProgressWrite = now;
                updateTrack(this.db, track.id, {
                  phase: progress.phase || 'downloading',
                  progress: Number(progress.progress) || 0,
                  speed: String(progress.speed || ''),
                  eta: Number.isFinite(progress.eta) ? progress.eta : null
                });
              }
              if (now - entry.lastEmit > 1000) {
                entry.lastEmit = now;
                this.onChange(job.user_id);
              }
            }
          }
        );

        const full = this.files.jobFile(job.user_id, job.id, result.filename);
        if (!full) throw new Error('Downloaded file is missing');
        if (full.size > this.config.maxFileBytes) {
          try {
            require('fs').unlinkSync(full.file);
          } catch {}
          throw new Error('File exceeds the configured size limit');
        }
        const updated = updateTrackIfStatus(this.db, track.id, 'running', {
          status: 'done',
          phase: null,
          progress: 100,
          speed: '',
          eta: null,
          size: full.size,
          filename: result.filename,
          error: null,
          completed_at: new Date().toISOString()
        });
        if (!updated) this.logger?.warn('Track finished after cancellation', { trackId: track.id });
      } catch (err) {
        const current = this.db.prepare('SELECT status FROM tracks WHERE id = ?').get(track.id);
        if (entry.cancelRequested || (controller.signal.aborted && !entry.timedOut)) {
          updateTrackIfStatus(this.db, track.id, 'running', {
            status: 'cancelled',
            phase: null,
            speed: '',
            eta: null,
            error: 'Cancelled'
          });
        } else if (current?.status === 'running') {
          const message = entry.timedOut
            ? 'Processing timed out'
            : err?.aborted
              ? 'Cancelled'
              : String(err.message || 'Download failed').slice(0, 500);
          updateTrackIfStatus(this.db, track.id, 'running', {
            status: 'failed',
            phase: null,
            speed: '',
            eta: null,
            error: message
          });
          this.logger?.warn('Track failed', { trackId: track.id, error: message });
        }
      } finally {
        clearTimeout(timeout);
        this.active.delete(track.id);
        try {
          refreshJob(this.db, job.id, this.config.retentionMs);
        } catch (err) {
          this.logger?.error('Job refresh failed', { jobId: job.id, error: err.message });
        }
        this.onChange(job.user_id);
        this.pump();
      }
    })();

    this.workerPromises.add(promise);
    promise.finally(() => this.workerPromises.delete(promise));
  }

  cancelJob(userId, jobId) {
    const result = cancelJob(this.db, userId, jobId);
    if (!result) return null;
    let running = 0;
    for (const entry of this.active.values()) {
      if (entry.jobId !== jobId) continue;
      running++;
      entry.cancelRequested = true;
      entry.controller.abort();
    }
    refreshJob(this.db, jobId, this.config.retentionMs);
    this.onChange(userId);
    return { cancelled: result.queuedCancelled + running, queued: result.queuedCancelled, running };
  }

  cleanup() {
    let expired;
    try {
      expired = expiredJobs(this.db);
    } catch (err) {
      this.logger?.error('Cleanup query failed', { error: err.message });
      return { removed: 0 };
    }
    let removed = 0;
    for (const { id, user_id: userId } of expired) {
      let active = false;
      for (const entry of this.active.values()) if (entry.jobId === id) active = true;
      if (active) continue;
      try {
        this.files.removeJob(userId, id);
        if (deleteExpiredJob(this.db, userId, id)) removed++;
        this.onCleanup(userId);
      } catch (err) {
        this.logger?.warn('Cleanup failed for job', { jobId: id, error: err.message });
      }
    }
    const { pruneSessions } = require('../storage');
    try {
      pruneSessions(this.db);
    } catch {}
    return { removed };
  }
}

module.exports = { Scheduler };
