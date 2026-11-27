'use strict';

const crypto = require('crypto');
const {
  parseYouTubeUrl,
  playlistIdFromUrl,
  videoIdFromUrl,
  sanitizeFolder,
  parseSelection,
  isKnownAudioFormat,
  isKnownVideoFormat
} = require('../core');
const repo = require('../storage');
const { serializeJob, serializeJobList, safeFolderName } = require('./serialize');

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function createJobsService({ db, adapter, files, config, scheduler, signer, tools }) {
  const previewCache = new Map(); // `${userId}:${url}` -> { expires, value }

  // Bound the in-memory preview cache. Expired entries are dropped first, then
  // the oldest entries, so many users or many distinct links cannot grow it
  // without limit.
  function trimPreviewCache() {
    const now = Date.now();
    for (const [key, item] of previewCache) {
      if (item.expires <= now) previewCache.delete(key);
    }
    const max = config.previewCacheMax || 500;
    while (previewCache.size >= max) {
      const oldest = previewCache.keys().next().value;
      if (oldest === undefined) break;
      previewCache.delete(oldest);
    }
  }

  function capabilities() {
    return require('../contracts').capabilitiesFor(config.mode);
  }

  function statusFor(userId) {
    return {
      mode: config.mode,
      apiVersion: config.apiVersion,
      paused: Boolean(repo.getSetting(db, userId, 'paused', false)),
      workers: config.perUserConcurrency,
      active: scheduler ? scheduler.activeFor(userId) : 0,
      queued: repo.queueDepth(db, userId),
      retentionHours: Math.round(config.retentionMs / 3_600_000),
      capabilities: capabilities(),
      tools: {
        yt: Boolean(tools?.yt) || config.engine === 'mock',
        ffmpeg: Boolean(tools?.ffmpeg) || config.engine === 'mock'
      }
    };
  }

  function listJobs(userId) {
    const rows = repo.getJobsWithTracks(db, userId);
    return {
      jobs: serializeJobList(rows, { signer, config }),
      status: statusFor(userId)
    };
  }

  function getJob(userId, jobId) {
    const row = repo.getJob(db, userId, jobId);
    return row ? serializeJob(row, { signer, config }) : null;
  }

  async function preview(userId, urls) {
    const unique = [...new Set(urls.map((url) => String(url || '').trim()).filter(Boolean))];
    if (!unique.length) throw Object.assign(new Error('Paste at least one YouTube link'), { status: 400 });
    if (unique.length > config.maxLinksPerRequest) {
      throw Object.assign(new Error(`At most ${config.maxLinksPerRequest} links at once`), { status: 400 });
    }
    for (const url of unique) {
      if (!parseYouTubeUrl(url))
        throw Object.assign(new Error('Only YouTube links are supported'), { status: 400 });
    }

    const sources = [];
    const errors = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, unique.length) }, async () => {
      while (cursor < unique.length) {
        const url = unique[cursor++];
        const cacheKey = `${userId}:${url}`;
        const cached = previewCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
          sources.push(cached.value);
          continue;
        }
        try {
          const meta = await adapter.extract(url);
          if (meta.entries.length > config.maxPlaylistEntries) {
            throw new Error(
              `That playlist has ${meta.entries.length} tracks; the limit is ${config.maxPlaylistEntries}`
            );
          }
          const value = {
            url,
            title: meta.title,
            thumb: meta.thumb,
            single: meta.single,
            entries: meta.entries,
            formats: null
          };
          trimPreviewCache();
          previewCache.set(cacheKey, { expires: Date.now() + config.previewCacheTtlMs, value });
          sources.push(value);
        } catch (err) {
          errors.push({ url, error: String(err.message || 'Could not read that link') });
        }
      }
    });
    await Promise.all(workers);
    sources.sort((a, b) => unique.indexOf(a.url) - unique.indexOf(b.url));
    return { sources, errors };
  }

  async function probe(url) {
    const parsed = parseYouTubeUrl(url);
    if (!parsed) throw Object.assign(new Error('A YouTube link is required'), { status: 400 });
    return adapter.probe(parsed.toString());
  }

  async function createJobs(userId, body = {}) {
    const rawItems = Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.urls)
        ? body.urls
        : [body.url];
    const items = [];
    for (const raw of rawItems) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw === 'string') items.push({ url: raw, selected: null });
      else items.push({ url: raw.url, selected: raw.selected });
    }
    if (!items.length) throw Object.assign(new Error('Paste at least one YouTube link'), { status: 400 });
    if (items.length > config.maxLinksPerRequest) {
      throw Object.assign(new Error(`At most ${config.maxLinksPerRequest} links at once`), { status: 400 });
    }
    if (repo.countJobs(db, userId) >= config.maxJobsPerUser) {
      throw Object.assign(new Error('Your library is full. Remove old downloads first.'), {
        status: 429,
        code: 'limit_exceeded'
      });
    }
    if (repo.countQueuedTracks(db, userId) >= config.maxQueuedTracksPerUser) {
      throw Object.assign(new Error('Your download queue is full. Wait for tracks to finish.'), {
        status: 429,
        code: 'limit_exceeded'
      });
    }

    const isVideo = Boolean(body.isVideo);
    const format = String(body.format || (isVideo ? '1080p' : 'mp3'));
    const valid = isVideo ? isKnownVideoFormat(format) : isKnownAudioFormat(format);
    if (!valid) throw Object.assign(new Error('Unknown quality option'), { status: 400 });
    const collection = sanitizeFolder(String(body.collection || ''), '', 120);
    const allowDuplicate = Boolean(body.allowDuplicate);

    const created = [];
    const errors = [];
    const seen = new Set();

    for (const item of items) {
      const parsed = parseYouTubeUrl(String(item.url || '').trim());
      if (!parsed) {
        errors.push({ url: String(item.url || ''), error: 'Only YouTube links are supported' });
        continue;
      }
      const url = parsed.toString();
      if (seen.has(url)) continue;
      seen.add(url);
      const listId = playlistIdFromUrl(url);
      const videoId = videoIdFromUrl(url);
      const playlistKey = listId ? `pl:${listId}` : `vid:${videoId || url}`;

      if (!allowDuplicate && repo.findDuplicate(db, userId, playlistKey)) {
        errors.push({ url, error: 'Already in your library', duplicate: true });
        continue;
      }

      let meta;
      try {
        meta = await adapter.extract(url);
      } catch (err) {
        errors.push({ url, error: String(err.message || 'Could not read that link') });
        continue;
      }
      if (meta.entries.length > config.maxPlaylistEntries) {
        errors.push({
          url,
          error: `That playlist has ${meta.entries.length} tracks; the limit is ${config.maxPlaylistEntries}`
        });
        continue;
      }

      let chosen = meta.entries;
      if (Array.isArray(item.selected) && item.selected.length) {
        const indexes = parseSelection(
          item.selected,
          Math.max(...meta.entries.map((entry) => entry.index), 1)
        );
        if (!indexes) {
          errors.push({ url, error: 'Select at least one valid track' });
          continue;
        }
        chosen = meta.entries.filter((entry) => indexes.has(entry.index));
      }
      if (!chosen.length) {
        errors.push({ url, error: 'Nothing playable was found at that link' });
        continue;
      }
      if (chosen.length > config.maxTracksPerJob) {
        errors.push({ url, error: `At most ${config.maxTracksPerJob} tracks can be added at once` });
        continue;
      }

      const id = `job_${uuid()}`;
      const job = {
        id,
        userId,
        sourceUrl: url,
        playlistKey: meta.playlistKey || playlistKey,
        playlistId: meta.playlistId || listId || '',
        title: String(meta.title || 'YouTube').slice(0, 300),
        thumb: meta.thumb || null,
        folderName: safeFolderName(collection || meta.title, listId || videoId || 'Playlist'),
        status: 'queued',
        single: Boolean(meta.single),
        isVideo,
        format,
        collection,
        createdAt: nowIso()
      };
      const tracks = chosen.map((entry, i) => ({
        id: `trk_${uuid()}`,
        index: i + 1,
        videoId: entry.videoId,
        title: String(entry.title || `Track ${i + 1}`).slice(0, 300),
        artist: String(entry.artist || '').slice(0, 200),
        album: String(meta.title || '').slice(0, 200)
      }));

      try {
        repo.insertJob(db, job, tracks);
      } catch (err) {
        errors.push({ url, error: 'Could not save the job' });
        continue;
      }
      created.push({ id, title: job.title, trackCount: tracks.length, isVideo, format });
    }

    if (created.length && scheduler) scheduler.notify();
    return { created, errors };
  }

  function retry(userId, jobId, trackId = '') {
    if (trackId && !/^trk_[A-Za-z0-9-]{8,}$/.test(String(trackId))) {
      throw Object.assign(new Error('Invalid track id'), { status: 400 });
    }
    const count = repo.retryJob(db, userId, jobId, trackId);
    if (count === false) return null;
    if (count) scheduler?.notify();
    return { retried: count };
  }

  function cancel(userId, jobId) {
    const result = scheduler.cancelJob(userId, jobId);
    if (!result) return null;
    return { cancelled: result.cancelled };
  }

  function remove(userId, jobId) {
    const result = repo.removeJob(db, userId, jobId);
    if (result === 'removed') files.removeJob(userId, jobId);
    return result;
  }

  function setPaused(userId, paused) {
    repo.setSetting(db, userId, 'paused', Boolean(paused));
    if (!paused) scheduler?.notify();
    return statusFor(userId);
  }

  function getSettings(userId) {
    return {
      isVideo: Boolean(repo.getSetting(db, userId, 'isVideo', false)),
      paused: Boolean(repo.getSetting(db, userId, 'paused', false))
    };
  }

  function updateSettings(userId, body) {
    if (body.isVideo !== undefined) repo.setSetting(db, userId, 'isVideo', Boolean(body.isVideo));
    if (body.paused !== undefined) repo.setSetting(db, userId, 'paused', Boolean(body.paused));
    // Arbitrary worker counts are intentionally ignored in cloud mode.
    if (!getSettings(userId).paused) scheduler?.notify();
    return statusFor(userId);
  }

  function history(userId) {
    const jobs = listJobs(userId).jobs;
    const rows = [];
    for (const job of jobs) {
      for (const track of job.tracks) {
        if (track.status !== 'done') continue;
        rows.push({
          title: track.title,
          artist: track.artist,
          album: job.albumTag,
          file: track.filename || '',
          completedAt: track.completedAt || job.finishedAt,
          jobId: job.id,
          trackId: track.id
        });
      }
    }
    rows.sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0));
    return rows;
  }

  function clearCache(userId) {
    let removed = 0;
    for (const key of [...previewCache.keys()]) {
      if (!key.startsWith(`${userId}:`)) continue;
      previewCache.delete(key);
      removed++;
    }
    return { removed };
  }

  function getDownloadRecord(userId, jobId, trackId) {
    const row = repo.getJob(db, userId, jobId);
    if (!row) return null;
    const track = row.tracks.find((t) => t.id === trackId && t.status === 'done' && t.filename);
    if (!track) return null;
    return { job: row.job, track };
  }

  return {
    capabilities,
    statusFor,
    listJobs,
    getJob,
    preview,
    probe,
    createJobs,
    retry,
    cancel,
    remove,
    setPaused,
    getSettings,
    updateSettings,
    history,
    clearCache,
    getDownloadRecord
  };
}

module.exports = { createJobsService };
