'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  getAudioFormat,
  getVideoFormat,
  VIDEO_ID_RE,
  parseYouTubeUrl,
  playlistIdFromUrl,
  videoIdFromUrl
} = require('../core');
const { runProcess } = require('../platform/process');
const { writeTags } = require('../media/tags');

function mockId(seed) {
  return crypto
    .createHash('sha256')
    .update(seed)
    .digest('base64url')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 11)
    .padEnd(11, 'x');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic media adapter for CI and local UI work. It never touches the
 * network or the real yt-dlp binary, but it implements the same cancellation
 * and progress contract as the production adapter.
 */
function createMockAdapter({ stepDelayMs = 25, bytes = 96 * 1024 } = {}) {
  return {
    name: 'mock',
    async extract(url, { signal } = {}) {
      const parsed = parseYouTubeUrl(url);
      if (!parsed) throw new Error('Only YouTube links are supported');
      const listId = playlistIdFromUrl(url);
      const videoId = videoIdFromUrl(url) || mockId(url);
      const seed = listId || videoId;
      const single = !listId;
      const count = single ? 1 : 3;
      const entries = Array.from({ length: count }, (_, i) => ({
        index: i + 1,
        videoId: mockId(`${seed}:${i}`),
        title: single ? `Mock Video ${seed}` : `Mock Track ${i + 1}`,
        artist: 'Mock Artist',
        duration: 120 + i
      }));
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' });
      return {
        playlistKey: listId ? `pl:${listId}` : `vid:${videoId}`,
        playlistId: listId,
        title: single ? entries[0].title : `Mock Playlist ${listId}`,
        thumb: `https://i.ytimg.com/vi/${entries[0].videoId}/hqdefault.jpg`,
        single,
        entries
      };
    },
    async probe() {
      return [2160, 1440, 1080, 720, 480, 360].map((height) => ({
        key: `${height}p`,
        label: `${height}p`,
        height
      }));
    },
    async download({ track, job, dir, filename }, { signal, onProgress } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' });
      const ext = job.is_video ? '.mp4' : getAudioFormat(job.format).ext || '.webm';
      const target = path.join(dir, filename(track, ext));
      fs.mkdirSync(dir, { recursive: true });
      const temp = `${target}.part`;
      const handle = fs.openSync(temp, 'w');
      try {
        const chunk = Buffer.alloc(16 * 1024, track.id.slice(-1));
        for (let step = 1; step <= 6; step++) {
          if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' });
          await sleep(stepDelayMs);
          if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' });
          const remaining = Math.max(0, bytes - fs.fstatSync(handle).size);
          if (remaining > 0) fs.writeSync(handle, chunk.subarray(0, Math.min(chunk.length, remaining)));
          onProgress?.({
            progress: Math.round((step / 6) * 100),
            speed: '1.0MiB/s',
            eta: Math.max(0, 6 - step),
            phase: step === 6 ? 'processing' : 'downloading'
          });
        }
      } catch (err) {
        try {
          fs.closeSync(handle);
        } catch {}
        try {
          fs.unlinkSync(temp);
        } catch {}
        throw err;
      }
      fs.closeSync(handle);
      fs.renameSync(temp, target);
      return { filename: path.basename(target), size: fs.statSync(target).size };
    }
  };
}

/**
 * Production adapter. Every argument is server-owned; titles, URLs and format
 * keys are validated before they reach yt-dlp. No shell, no user config.
 */
function createYtDlpAdapter({ ytdlpPath, ffmpegPath, logger, maxDurationMs = 30 * 60 * 1000 }) {
  if (!ytdlpPath) {
    const err = new Error('yt-dlp was not found. Set SNAGLY_YTDLP_PATH or install it on PATH.');
    err.code = 'ENOENT';
    throw err;
  }
  const base = [
    '--ignore-config',
    '--no-warnings',
    '--no-cache-dir',
    '--socket-timeout',
    '20',
    '--retries',
    '3'
  ];

  function normalizeThumb(value) {
    if (!value) return null;
    const text = String(value);
    if (text.startsWith('//')) return `https:${text}`;
    return /^https:\/\//.test(text) ? text : null;
  }

  function parseJson(stdout) {
    try {
      const data = JSON.parse(stdout);
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  async function extract(url, { signal } = {}) {
    const { stdout } = await runProcess(
      ytdlpPath,
      [...base, '--dump-single-json', '--flat-playlist', '--skip-download', url],
      { signal, timeoutMs: 120_000, maxOutputBytes: 32 * 1024 * 1024 }
    );
    const data = parseJson(stdout);
    if (!data) throw new Error('yt-dlp returned invalid metadata');
    const listId = playlistIdFromUrl(url) || (data._type === 'playlist' ? String(data.id || '') : '');
    const rawEntries = Array.isArray(data.entries) && data.entries.length ? data.entries : [data];
    const entries = [];
    for (const entry of rawEntries) {
      const id = String(entry?.id || '');
      if (!VIDEO_ID_RE.test(id)) continue;
      entries.push({
        index: entries.length + 1,
        videoId: id,
        title: String(entry.title || id).slice(0, 300),
        artist: String(entry.artist || entry.uploader || entry.channel || '').slice(0, 200),
        duration: Number.isFinite(entry.duration) ? entry.duration : null
      });
    }
    if (!entries.length) throw new Error('Nothing playable was found at that link');
    return {
      playlistKey: listId ? `pl:${listId}` : `vid:${videoIdFromUrl(url) || entries[0].videoId}`,
      playlistId: listId,
      title: String(data.title || entries[0].title || 'YouTube').slice(0, 300),
      thumb: normalizeThumb(
        data.thumbnail || (Array.isArray(data.thumbnails) ? data.thumbnails.at(-1)?.url : '')
      ),
      single: !listId,
      entries
    };
  }

  async function probe(url, { signal } = {}) {
    const { stdout } = await runProcess(ytdlpPath, [...base, '-J', '--no-playlist', url], {
      signal,
      timeoutMs: 90_000,
      maxOutputBytes: 32 * 1024 * 1024
    });
    const data = parseJson(stdout);
    const heights = new Set();
    for (const format of data?.formats || []) {
      if (Number.isInteger(format.height) && format.height >= 144 && format.height <= 4320)
        heights.add(format.height);
    }
    return [...heights]
      .sort((a, b) => b - a)
      .map((height) => ({
        key: `${height}p`,
        label: `${height}p`,
        height
      }));
  }

  async function download({ track, job, dir, filename }, { signal, onProgress } = {}) {
    const format = job.is_video ? getVideoFormat(job.format) : getAudioFormat(job.format);
    if (!VIDEO_ID_RE.test(track.video_id)) throw new Error('Invalid video id');
    const args = [
      ...base,
      ...format.args,
      '--no-playlist',
      '--newline',
      '--paths',
      dir,
      '--output',
      `${track.video_id}.%(ext)s`
    ];
    if (job.is_video) args.push('--merge-output-format', 'mp4');
    else args.push('--embed-metadata', '--add-metadata');
    if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
    args.push(`https://www.youtube.com/watch?v=${track.video_id}`);

    let lastEmit = 0;
    const onStdout = (text) => {
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(
          /\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*([\d.]+\s*[KMGTP]?i?B))?(?:\s+at\s+(\S+))?(?:\s+ETA\s+([\d:]+))?/i
        );
        if (match) {
          const now = Date.now();
          if (now - lastEmit < 400) continue;
          lastEmit = now;
          const etaParts = String(match[4] || '')
            .split(':')
            .map(Number)
            .filter(Number.isFinite);
          const eta = etaParts.length ? etaParts.reduce((total, part) => total * 60 + part, 0) : null;
          onProgress?.({
            progress: Math.min(99, Number(match[1]) || 0),
            speed: match[3] || '',
            eta,
            phase: 'downloading'
          });
        } else if (/\[(ExtractAudio|Merger|Metadata|Fixup)/.test(line)) {
          onProgress?.({ progress: 99, speed: '', eta: 0, phase: 'processing' });
        }
      }
    };

    try {
      await runProcess(ytdlpPath, args, {
        signal,
        timeoutMs: maxDurationMs,
        onStdout,
        maxOutputBytes: 16 * 1024 * 1024
      });
    } catch (err) {
      cleanup(track.video_id, dir);
      throw err;
    }

    const found = findOutput(track.video_id, dir);
    if (!found) throw new Error('Download finished without a media file');
    const ext = path.extname(found).toLowerCase();
    const target = path.join(dir, filename(track, ext));
    if (target !== found) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fs.renameSync(found, target);
    }

    if (ffmpegPath && !job.is_video) {
      try {
        await writeTags({
          ffmpegPath,
          file: target,
          tags: { title: track.title, artist: track.artist, album: track.album },
          timeoutMs: 60_000
        });
      } catch (err) {
        logger?.warn('Tagging failed', { trackId: track.id, error: err.message });
      }
    }
    return { filename: path.basename(target), size: fs.statSync(target).size };
  }

  function cleanup(id, dir) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${id}.`) && /\.(part|ytdl|temp)$/i.test(name)) {
          fs.unlinkSync(path.join(dir, name));
        }
      }
    } catch {}
  }

  function findOutput(id, dir) {
    const candidates = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${id}.`)) continue;
      if (/\.(part|ytdl|temp)$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.size > 0) candidates.push({ full, size: stat.size });
      } catch {}
    }
    candidates.sort((a, b) => b.size - a.size);
    return candidates[0]?.full || null;
  }

  return { name: 'yt-dlp', extract, probe, download };
}

module.exports = { createMockAdapter, createYtDlpAdapter, mockId };
