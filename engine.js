'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const {
  parseYouTubeUrl,
  isPathInside,
  escapeRegExp,
  safeJsonParse,
  sanitizeTags,
  isMediaFile
} = require('./lib/util');

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.SNAGLY_DATA_DIR
  ? path.resolve(process.env.SNAGLY_DATA_DIR)
  : path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_BACKUP = path.join(DATA_DIR, 'state.backup.json');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const MAX_PROCESS_OUTPUT = 64 * 1024 * 1024;
const MAX_SSE_CLIENTS = 10;
const MEDIA_FILE_RE = /\.(mp3|m4a|aac|flac|opus|ogg|oga|wav|webm|mp4|mkv|mov|m4v)$/i;

const FORMATS = {
  mp3: { ext: 'mp3', args: ['-x', '--audio-format', 'mp3', '--audio-quality', '320K'], label: 'MP3 320 kbps' },
  mp3v0: { ext: 'mp3', args: ['-x', '--audio-format', 'mp3', '--audio-quality', 'V0'], label: 'MP3 V0 (VBR)' },
  flac: { ext: 'flac', args: ['-x', '--audio-format', 'flac'], label: 'FLAC (lossless)' },
  opus: { ext: 'opus', args: ['-x', '--audio-format', 'opus', '--audio-quality', '0'], label: 'Opus' },
  m4a: { ext: 'm4a', args: ['-x', '--audio-format', 'm4a', '--audio-quality', '0'], label: 'M4A / AAC' },
  best: { ext: '', args: ['-f', 'bestaudio/best'], label: 'Best available (original)' }
};

// Video picks are ceilings: `height<=N` means a source that tops out at 1080p
// still downloads fine when the batch asks for 2160p.
function videoArgs(height) {
  return [
    '-f',
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/` +
    `bestvideo[height<=${height}]+bestaudio/` +
    `best[height<=${height}][ext=mp4]/best[height<=${height}]`
  ];
}

const VIDEO_FORMATS = {
  '2160p': { label: '4K MP4 (2160p)', args: videoArgs(2160), merge: true, ext: 'mp4' },
  '1440p': { label: '1440p MP4', args: videoArgs(1440), merge: true, ext: 'mp4' },
  '1080p': { label: '1080p MP4', args: videoArgs(1080), merge: true, ext: 'mp4' },
  '720p': { label: '720p MP4', args: videoArgs(720), merge: true, ext: 'mp4' },
  '480p': { label: '480p MP4', args: videoArgs(480), merge: true, ext: 'mp4' },
  '360p': { label: '360p MP4', args: videoArgs(360), merge: true, ext: 'mp4' },
  // Used when the source tops out below the smallest ladder rung. The label
  // is set by the client to the real source height.
  source: { label: 'Source quality', args: ['-f', 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best'], merge: true, ext: 'mp4' },
  best: { label: 'Best quality', args: ['-f', 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best'], merge: true, ext: 'mp4' }
};

const VIDEO_LADDER = [2160, 1440, 1080, 720, 480, 360];

const emptyState = () => ({
  jobs: [],
  manifest: {},
  paused: false,
  workers: 5,
  useCookies: false,
  format: 'mp3',
  isVideo: false,
  collection: '',
  root: path.join(os.homedir(), 'Music'),
  createdAt: new Date().toISOString()
});

let state = emptyState();
let tools = {};
let listeners = new Set();
let activeCount = 0;
let penaltyMs = 0;
let pumping = false;
const runningProcesses = new Map(); // trackId -> { child, kill }

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const sleep = ms => new Promise(r => setTimeout(r, ms));

function emit(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of listeners) {
    try { res.write(line); } catch { listeners.delete(res); }
  }
}

function broadcast(extra = {}) {
  emit({ type: 'state', jobs: publicJobs(), paused: state.paused, workers: effectiveWorkers(), active: activeCount, penaltyMs, ...extra });
}

function publicJobs() {
  if (!Array.isArray(state.jobs)) state.jobs = [];
  return state.jobs.map(j => ({
    id: j.id, url: j.url, playlistId: j.playlistId, title: j.title,
    thumb: j.thumb, folder: j.folder, status: j.status,
    single: Boolean(j.single), isVideo: Boolean(j.isVideo), format: j.format || null,
    createdAt: j.createdAt, finishedAt: j.finishedAt,
    trackCount: j.tracks.length,
    done: j.tracks.filter(t => t.status === 'done').length,
    failed: j.tracks.filter(t => t.status === 'failed').length,
    cancelled: j.tracks.filter(t => t.status === 'cancelled').length,
    missing: j.tracks.filter(t => t.status === 'missing').length,
    running: j.tracks.filter(t => t.status === 'running').length,
    tracks: j.tracks.map(t => ({
      index: t.index, id: t.id, title: t.title, artist: t.artist,
      status: t.status, error: t.error, warning: t.warning || null, file: t.file, size: t.size,
      phase: t.phase || null, progress: t.progress || 0,
      downloaded: t.downloaded || 0, total: t.total || 0,
      speed: t.speed || '', eta: t.eta ?? null
    }))
  }));
}

// Keep the library in step with what is actually on disk. Jobs whose output
// folder was deleted disappear; finished tracks whose file was deleted are
// flagged "missing" so they can be re-downloaded from the library.
const LIBRARY_FOLDER_CHECK_MS = 6000;
const LIBRARY_FILE_CHECK_MS = 30000;
let lastFolderCheck = 0;
let lastFileCheck = 0;

function reconcileLibrary(force = false) {
  const now = Date.now();
  if (!force && now - lastFolderCheck < LIBRARY_FOLDER_CHECK_MS) return false;
  lastFolderCheck = now;
  const deep = force || now - lastFileCheck > LIBRARY_FILE_CHECK_MS;
  if (deep) lastFileCheck = now;

  let changed = false;
  let removed = 0;
  const kept = [];
  for (const job of state.jobs) {
    const active = job.status === 'running' || job.status === 'queued' ||
      job.tracks.some(t => t.status === 'running' || t.status === 'queued');
    if (active) { kept.push(job); continue; }

    // Folder gone (whole playlist/single deleted from disk) -> drop the entry.
    if (!job.folder || !fs.existsSync(job.folder)) {
      for (const t of job.tracks) {
        if (state.manifest[t.id]?.jobId === job.id) delete state.manifest[t.id];
      }
      changed = true;
      removed++;
      continue;
    }

    if (deep) {
      let touched = false;
      for (const t of job.tracks) {
        const fileThere = Boolean(t.file && fs.existsSync(t.file));
        if (t.status === 'done' && !fileThere) {
          t.status = 'missing';
          t.phase = 'missing';
          t.progress = 0;
          t.downloaded = 0;
          t.total = 0;
          t.speed = '';
          t.eta = null;
          t.error = 'File no longer on disk';
          touched = true;
        } else if (t.status === 'missing' && fileThere) {
          t.status = 'done';
          t.phase = 'done';
          t.progress = 100;
          t.error = null;
          touched = true;
        }
      }
      if (touched) {
        changed = true;
        const done = job.tracks.filter(t => t.status === 'done').length;
        const missing = job.tracks.filter(t => t.status === 'missing').length;
        if (job.status === 'done' || job.status === 'partial' || job.status === 'failed') {
          if (!missing) job.status = done === job.tracks.length ? 'done' : (done > 0 ? 'partial' : job.status);
          else job.status = done > 0 ? 'partial' : 'failed';
        }
      }
    }
    kept.push(job);
  }

  if (changed) {
    if (kept.length !== state.jobs.length) state.jobs = kept;
    saveState();
    broadcast(removed ? { libraryRemoved: removed } : {});
  }
  return changed;
}

let libraryTimer = null;
function startLibraryWatcher() {
  if (libraryTimer) return;
  libraryTimer = setInterval(() => reconcileLibrary(), LIBRARY_FOLDER_CHECK_MS);
  libraryTimer.unref?.();
}

function applyLoadedState(parsed) {
  state = { ...emptyState(), ...parsed };
  if (!Array.isArray(state.jobs)) state.jobs = [];
  if (typeof state.manifest !== 'object' || state.manifest === null) state.manifest = {};
  if (typeof state.root !== 'string' || !path.isAbsolute(state.root)) {
    state.root = path.join(os.homedir(), 'Music');
  }
  // The old placeholder collection was never exposed in the UI. Clear it so a
  // fresh library lands in <save folder>\<playlist> as documented.
  if (state.collection === 'Worship Pad') state.collection = '';
  for (const job of state.jobs) {
    if (job.status === 'running' || job.status === 'queued') job.status = 'queued';
    for (const t of job.tracks || []) {
      if (t.status === 'running') t.status = 'queued';
    }
  }
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const file of [STATE_FILE, STATE_BACKUP]) {
    if (!fs.existsSync(file)) continue;
    const parsed = safeJsonParse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      applyLoadedState(parsed);
      return;
    }
  }
}

function writeStateFile() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_BACKUP);
  } catch { /* a missing backup must never block a save */ }
  fs.renameSync(tmp, STATE_FILE);
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeStateFile(); } catch (err) { console.error('Snagly could not save state:', err.message); }
  }, 120);
}

function saveStateNow() {
  clearTimeout(saveTimer);
  try { writeStateFile(); } catch (err) { console.error('Snagly could not save state:', err.message); }
}

function cookieSource() {
  try { if (fs.existsSync(COOKIES_FILE)) return 'file'; } catch { /* ignore */ }
  return tools.browser ? 'browser' : null;
}

function cookieArgs() {
  if (!state.useCookies) return [];
  if (cookieSource() === 'file') return ['--cookies', COOKIES_FILE];
  return tools.browser ? ['--cookies-from-browser', tools.browser] : [];
}

function discoverTools() {
  const wingetRoot = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  let yt = '';
  let ffmpeg = '';
  let ffprobe = '';
  try {
    for (const entry of fs.readdirSync(wingetRoot)) {
      if (!/yt-dlp/i.test(entry)) continue;
      const base = path.join(wingetRoot, entry);
      if (!yt) {
        const candidate = path.join(base, 'yt-dlp.exe');
        if (fs.existsSync(candidate)) yt = candidate;
      }
      const ffmpegRoot = path.join(wingetRoot, entry.replace('yt-dlp.yt-dlp.', 'yt-dlp.FFmpeg.'));
      if (fs.existsSync(ffmpegRoot)) {
        const walk = dir => {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, item.name);
            if (item.isDirectory()) walk(p);
            else if (item.name === 'ffmpeg.exe' && !ffmpeg) ffmpeg = p;
            else if (item.name === 'ffprobe.exe' && !ffprobe) ffprobe = p;
          }
        };
        walk(ffmpegRoot);
      }
    }
  } catch { /* handled by status endpoint */ }

  // Non-Windows (or a missing WinGet install): fall back to PATH lookups.
  if (!yt || !ffmpeg || !ffprobe) {
    const which = name => {
      try {
        const cmd = process.platform === 'win32' ? 'where' : 'sh';
        const args = process.platform === 'win32' ? [name] : ['-c', `command -v ${name}`];
        const out = execFileSync(cmd, args, { encoding: 'utf8' }).trim();
        return out.split(/\r?\n/)[0] || '';
      } catch { return ''; }
    };
    if (!yt) yt = which('yt-dlp');
    if (!ffmpeg) ffmpeg = which('ffmpeg');
    if (!ffprobe) ffprobe = which('ffprobe');
  }

  const browsers = [
    ['chrome', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')],
    ['edge', path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data')],
    ['firefox', path.join(os.homedir(), 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles')]
  ];
  const browser = browsers.find(([, p]) => fs.existsSync(p))?.[0] || null;

  tools = { yt, ffmpeg, ffprobe, browser };
  return tools;
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch { /* fall through */ }
  }
  try { child.kill('SIGTERM'); } catch {}
}

function runProcess(exe, args, timeoutMs = 0, onStdout = null, trackId = null) {
  return new Promise(resolve => {
    if (!exe) return resolve({ code: -1, stdout: '', stderr: 'Tool not found' });
    let stdout = '';
    let stderr = '';
    let done = false;
    let oversized = false;
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (trackId) {
      runningProcesses.set(trackId, { child, kill: () => killProcessTree(child) });
    }
    child.stdout.on('data', d => {
      const text = d.toString();
      if (stdout.length + text.length > MAX_PROCESS_OUTPUT) {
        oversized = true;
        killProcessTree(child);
        return;
      }
      stdout += text;
      if (onStdout) onStdout(text, false);
    });
    child.stderr.on('data', d => {
      if (stderr.length < MAX_PROCESS_OUTPUT) stderr += d.toString();
    });
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { try { killProcessTree(child); } catch {} }, timeoutMs);
    function cleanup() {
      if (trackId) runningProcesses.delete(trackId);
    }
    child.on('error', err => {
      if (done) return; done = true; clearTimeout(timer); cleanup();
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
    child.on('close', code => {
      if (done) return; done = true; clearTimeout(timer); cleanup();
      if (onStdout) onStdout('', true);
      if (oversized) {
        return resolve({ code: -1, stdout: '', stderr: 'Tool output exceeded the size limit' });
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function sanitizeFolder(name) {
  return String(name).replace(/[<>:"\/\\|?*\x00-\x1F]/g, '').replace(/[. ]+$/, '').trim() || 'Playlist';
}

function isSingleVideo(url) {
  return /(?:youtube\.com\/watch\?|youtu\.be\/|youtube\.com\/shorts\/)/i.test(url) && !/[?&]list=/i.test(url);
}

async function extractPlaylist(url) {
  if (!parseYouTubeUrl(url)) return { error: 'Only YouTube links are supported' };
  const listId = (url.match(/[?&]list=([^&]+)/) || [])[1];
  const videoId = (url.match(/(?:v=|\/shorts\/|youtu\.be\/)([\w-]{11})/) || [])[1];
  const cacheKey = (listId || videoId || url).slice(0, 120);
  const cacheFile = path.join(CACHE_DIR, `${sanitizeFolder(cacheKey)}.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = safeJsonParse(fs.readFileSync(cacheFile, 'utf8'));
    // Single-video entries need their format list for the quality menu.
    // Entries written before that was stored are re-extracted once.
    if (cached?.entries?.length && (!cached.single || cached.formats)) {
      const cachedAt = cached.cachedAt || 0;
      if (Date.now() - cachedAt < CACHE_MAX_AGE_MS) {
        return { ...cached, cached: true };
      }
    }
  }
  // Reading Chrome's cookie database costs several seconds per yt-dlp run,
  // and most public links do not need it. Try plain first, then sign in.
  const baseArgs = ['--flat-playlist', '--dump-single-json', '--no-warnings', '--skip-download', url];
  const extra = cookieArgs();
  const attempts = extra.length
    ? [baseArgs, [...baseArgs, ...extra]]
    : [baseArgs];
  let r;
  for (const args of attempts) {
    r = await runProcess(tools.yt, args, 120000);
    if (r.code === 0) break;
  }
  if (r.code !== 0) {
    const stderr = String(r.stderr || '').trim();
    if (/could not copy chrome cookie|cookie database/i.test(stderr)) {
      return { error: 'Browser cookies are locked because the browser is running. Close the browser and try again, or add a cookies.txt file next to server.js.' };
    }
    if (/sign in to confirm|not a bot/i.test(stderr)) {
      return { error: 'YouTube asked for a sign-in check. Turn on Use YouTube sign-in in the composer and try again.' };
    }
    return { error: stderr.slice(-600) };
  }
  const parsed = parseExtraction(r.stdout, url);
  if (!parsed.error) {
    parsed.cachedAt = Date.now();
    try { fs.writeFileSync(cacheFile, JSON.stringify(parsed, null, 2), 'utf8'); } catch {}
  }
  return parsed;
}

function parseExtraction(stdout, url = '') {
  try {
    const start = stdout.indexOf('{');
    const data = JSON.parse(stdout.slice(start));
    const rawEntries = data.entries?.length
      ? data.entries
      : (data.id ? [data] : []);
    const single = !data.entries?.length && Boolean(data.id);
    const entries = rawEntries
      .filter(e => e && /^[A-Za-z0-9_-]{11}$/.test(String(e.id)))
      .slice(0, 5000)
      .map((e, i) => ({
        id: e.id,
        index: e.playlist_index || i + 1,
        title: e.title || `Track ${i + 1}`,
        artist: e.channel || e.uploader || '',
        thumb: e.thumbnails?.[0]?.url || (e.id ? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` : '')
      }));
    return {
      id: data.id || '',
      title: single ? 'Single video' : (data.title || 'Untitled playlist'),
      entries,
      thumb: entries[0]?.thumb || '',
      single,
      // A single video's metadata already contains the full format list, so
      // there is no need to spend a second yt-dlp call probing it.
      formats: single ? summarizeFormats(data.formats) : null,
      originalTitle: single ? (data.title || '') : '',
      originalUrl: url,
      cached: false
    };
  } catch (err) {
    return { error: `Could not read playlist metadata: ${err.message}` };
  }
}

const probeCache = new Map();
const PROBE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PROBE_FAIL_TTL_MS = 2 * 60 * 1000;

function audioCodecLabel(codec) {
  const c = String(codec || '');
  if (/opus/i.test(c)) return 'Opus';
  if (/aac|mp4a/i.test(c)) return 'AAC';
  if (/vorbis/i.test(c)) return 'Vorbis';
  if (/mp3/i.test(c)) return 'MP3';
  return c && c !== 'none' ? c.split('.')[0] : 'Audio';
}

function summarizeFormats(formats) {
  if (!Array.isArray(formats) || !formats.length) return null;
  const video = formats.filter(f => f && f.vcodec && f.vcodec !== 'none' && Number(f.height) > 0);
  const audio = formats.filter(f => f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  // `height` is the raw frame height: a 2:1 video labels 3840x1920 as 4K.
  // format_note carries the real quality tier ("2160p"), fall back to the
  // smaller dimension so portrait videos don't look taller than they are.
  const tier = f => {
    const note = String(f.format_note || '').match(/(\d{3,4})p/);
    if (note) return Number(note[1]);
    const h = Number(f.height) || 0;
    const w = Number(f.width) || 0;
    return h && w ? Math.min(h, w) : h;
  };
  const maxHeight = video.reduce((n, f) => Math.max(n, tier(f)), 0);
  const bestAudio = audio.reduce((best, f) => {
    const kbps = Number(f.abr || f.tbr) || 0;
    return !best || kbps > best.kbps ? { kbps, codec: audioCodecLabel(f.acodec) } : best;
  }, null);
  return {
    maxHeight,
    heights: VIDEO_LADDER.filter(h => h <= maxHeight),
    audio: bestAudio ? { kbps: Math.round(bestAudio.kbps), codec: bestAudio.codec } : null
  };
}

function probeKey(url) {
  return (url.match(/[?&]list=([^&]+)/) || [])[1]
    || (url.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{11})/) || [])[1]
    || url;
}

function probeCacheFile(key) {
  return path.join(CACHE_DIR, `probe-${sanitizeFolder(key).slice(0, 80)}.json`);
}

function readProbeCache(key) {
  const hit = probeCache.get(key);
  if (hit) {
    const ttl = hit.data ? PROBE_TTL_MS : PROBE_FAIL_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit;
    probeCache.delete(key);
  }
  try {
    const disk = safeJsonParse(fs.readFileSync(probeCacheFile(key), 'utf8'));
    if (disk?.data && Date.now() - (disk.at || 0) < PROBE_TTL_MS) {
      probeCache.set(key, disk);
      return disk;
    }
  } catch { /* no usable cache */ }
  return null;
}

// Reads the real format list for the first video of a link. Returns the
// tallest height and the best audio stream so the UI can offer only what
// the source actually has. Cached on disk and in memory: previews re-fire
// as you type, and the same link is usually pasted more than once.
async function probeFormats(url) {
  if (!parseYouTubeUrl(url)) return null;
  const key = probeKey(url);
  const hit = readProbeCache(key);
  if (hit) return hit.data;

  const baseArgs = [
    '--playlist-items', '1', '--skip-download', '--no-warnings',
    '--print', '%(formats)j', url
  ];
  const extra = cookieArgs();
  const attempts = extra.length
    ? [baseArgs, [...baseArgs, ...extra]]
    : [baseArgs];
  let r;
  for (const args of attempts) {
    r = await runProcess(tools.yt, args, 90000);
    if (r.code === 0) break;
  }
  if (r.code !== 0) {
    probeCache.set(key, { at: Date.now(), data: null });
    return null;
  }

  const line = r.stdout.split(/\r?\n/).find(l => l.trim().startsWith('['));
  if (!line) {
    probeCache.set(key, { at: Date.now(), data: null });
    return null;
  }
  let formats;
  try { formats = JSON.parse(line.trim()); } catch {
    probeCache.set(key, { at: Date.now(), data: null });
    return null;
  }

  const data = summarizeFormats(formats);
  if (!data) {
    probeCache.set(key, { at: Date.now(), data: null });
    return null;
  }
  const entry = { at: Date.now(), data };
  probeCache.set(key, entry);
  try { fs.writeFileSync(probeCacheFile(key), JSON.stringify(entry), 'utf8'); } catch {}
  return data;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// `probe: false` returns playlist metadata as soon as it is ready; the client
// fills in the quality menus with /api/probe while the track list is usable.
// Metadata only. Quality menus are filled by /api/probe so opening the track
// picker never waits on a second yt-dlp round trip.
async function previewSources(urls) {
  const results = await mapLimit(urls, 2, async url => {
    const meta = await extractPlaylist(url);
    return { url, meta, formats: meta.formats || null };
  });

  const sources = [];
  const errors = [];
  for (const { url, meta, formats } of results) {
    if (!meta || meta.error || !meta.entries?.length) {
      errors.push({ url, error: meta?.error || 'Nothing found at this link' });
      continue;
    }
    sources.push({
      url,
      id: meta.id,
      title: meta.single ? meta.originalTitle : meta.title,
      thumb: meta.thumb,
      single: Boolean(meta.single),
      cached: Boolean(meta.cached),
      formats,
      entries: meta.entries.map(e => ({ index: e.index, title: e.title, artist: e.artist }))
    });
  }
  return { sources, errors };
}

function prepareRoot(requested) {
  const value = String(requested || '').trim();
  if (!value) throw new Error('A save folder is required');
  if (!path.isAbsolute(value)) throw new Error('Save folder must be an absolute path');
  const root = path.normalize(value);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.statSync(root).isDirectory()) throw new Error('Save folder is not a directory');
  fs.accessSync(root, fs.constants.W_OK);
  return root;
}

async function createJobs(inputs, options = {}) {
  const root = prepareRoot(options.root || state.root);
  const collection = (options.collection ?? state.collection ?? '').trim();
  const format = options.format || state.format || 'mp3';
  const isVideo = Boolean(options.isVideo);
  const allowDuplicate = Boolean(options.allowDuplicate);
  const base = collection ? path.join(root, sanitizeFolder(collection)) : root;
  const items = inputs.slice(0, 50).map(input => typeof input === 'string' ? { url: input, selected: null } : input);
  const created = [];
  const errors = [];

  for (const { url, selected } of items) {
    if (!parseYouTubeUrl(url)) {
      errors.push({ url, error: 'Only YouTube links are supported' });
      continue;
    }
    const meta = await extractPlaylist(url);
    if (meta.error || !meta.entries?.length) {
      errors.push({ url, error: meta.error || 'Nothing found at this link' });
      continue;
    }
    let entries = meta.entries;
    if (Array.isArray(selected) && selected.length) {
      const wanted = new Set(selected.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 100000));
      entries = entries.filter(e => wanted.has(e.index));
      if (!entries.length) {
        errors.push({ url, error: 'None of those track numbers were found' });
        continue;
      }
    }

    // Duplicate detection: warn if this playlist (or single) is already queued/downloaded
    const dupKey = meta.single ? `single:${meta.id}` : `playlist:${meta.id}`;
    const existing = state.jobs.find(j => {
      const key = j.single ? `single:${j.playlistId}` : `playlist:${j.playlistId}`;
      return key === dupKey;
    });
    if (existing && !allowDuplicate) {
      errors.push({ url, error: `Already in library: "${existing.title}"`, duplicate: true });
      continue;
    }

    let folder = path.join(base, meta.single ? 'Singles' : sanitizeFolder(meta.title));
    if (!meta.single) {
      // Two different playlists can share a title. Never let their numbered
      // tracks overwrite each other in the same folder.
      const original = folder;
      let suffix = 2;
      while (
        fs.existsSync(folder) &&
        !state.jobs.some(j => j.playlistId === meta.id && j.folder && path.resolve(j.folder) === path.resolve(folder))
      ) {
        folder = `${original} (${suffix++})`;
        if (suffix > 99) break;
      }
    }
    fs.mkdirSync(folder, { recursive: true });
    const pad = entries.length > 99 ? 3 : 2;

    const fmt = isVideo
      ? (VIDEO_FORMATS[format] || VIDEO_FORMATS['1080p'])
      : (FORMATS[format || 'mp3'] || FORMATS.mp3);
    const ext = fmt.ext ? `.${fmt.ext}` : '';

    const tracks = entries.map(e => {
      const existingFile = findTrackFile(folder, e.index, pad, meta.single, e.id, ext);
      const recorded = state.manifest[e.id];
      const recordedOk = Boolean(
        recorded &&
        recorded.file &&
        fs.existsSync(recorded.file) &&
        isPathInside(folder, recorded.file)
      );
      const done = Boolean(existingFile || recordedOk);
      let size = 0;
      try { if (existingFile) size = fs.statSync(path.join(folder, existingFile)).size; } catch {}
      return {
        id: e.id,
        index: e.index,
        title: e.title,
        artist: e.artist,
        thumb: e.thumb,
        status: done ? 'done' : 'queued',
        error: null,
        warning: null,
        file: done ? (existingFile ? path.join(folder, existingFile) : recorded.file) : null,
        size,
        retries: 0,
        maxRetries: 2
      };
    });

    const job = {
      id: `j_${randomUUID().slice(0, 8)}`,
      url,
      playlistId: meta.id,
      title: meta.single ? (meta.originalTitle || meta.title) : meta.title,
      albumTag: meta.single ? 'Singles' : meta.title,
      single: Boolean(meta.single),
      thumb: meta.thumb,
      folder,
      status: 'queued',
      format,
      isVideo,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      pad,
      tracks
    };

    // If every track is already on disk, mark the job done immediately instead of leaving it stuck on 'queued'
    if (job.tracks.length && job.tracks.every(t => t.status === 'done')) {
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
    }

    state.jobs.unshift(job);
    created.push(job);
    saveState();
  }

  state.root = root;
  if (options.collection !== undefined) state.collection = options.collection;
  broadcast();
  saveState();
  pump();
  return { created: publicJobs().filter(j => created.some(c => c.id === j.id)), errors };
}

function mediaMatcher(ext) {
  if (!ext || ext === '.') return MEDIA_FILE_RE;
  return new RegExp(`${escapeRegExp(ext)}$`, 'i');
}

function findTrackFile(folder, index, pad = 2, single = false, id = '', ext = '.mp3') {
  const matcher = mediaMatcher(ext);
  if (single && id) {
    try {
      return fs.readdirSync(folder).find(f =>
        f.includes(`[${id}]`) && !f.endsWith('.part') && matcher.test(f)
      ) || null;
    } catch { return null; }
  }
  return findExisting(folder, index, pad, ext);
}

function findExisting(folder, index, pad = 2, ext = '.mp3') {
  try {
    const matcher = mediaMatcher(ext);
    const files = fs.readdirSync(folder).filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl') && matcher.test(f));
    for (const width of [pad, 2, 3]) {
      const prefix = `${String(index).padStart(width, '0')} - `;
      const found = files.find(f => f.startsWith(prefix));
      if (found) return found;
    }
    return null;
  } catch { return null; }
}

function noteThrottle(stderr) {
  if (/sign in to confirm|not a bot|http error 429|too many requests|rate.?limit/i.test(stderr)) {
    penaltyMs = Math.min(penaltyMs + 500, 3000);
  } else if (penaltyMs > 0) {
    penaltyMs = Math.max(0, penaltyMs - 60);
  }
}

function effectiveWorkers() {
  const reduction = penaltyMs >= 2000 ? 2 : penaltyMs >= 800 ? 1 : 0;
  return Math.max(1, Math.min(8, state.workers) - reduction);
}

function nextTrack() {
  for (const job of state.jobs) {
    if (!['queued', 'running'].includes(job.status)) continue;
    const track = job.tracks.find(t => t.status === 'queued');
    if (track) return { job, track };
  }
  return null;
}

function pump() {
  if (pumping || state.paused) return;
  pumping = true;
  try {
    while (activeCount < effectiveWorkers()) {
      const next = nextTrack();
      if (!next) break;
      next.track.status = 'running';
      next.track.phase = 'preparing';
      next.track.startedAt = Date.now();
      next.job.status = 'running';
      activeCount++;
      processTrack(next.job, next.track).finally(() => {
        activeCount--;
        finalizeJob(next.job);
        saveState();
        broadcast();
        pump();
      });
    }
  } finally {
    pumping = false;
  }
  if (activeCount === 0 && !nextTrack()) {
    // Safety net: finalize any jobs whose tracks are all done but status never flipped
    for (const job of state.jobs) {
      if (job.status === 'queued' && job.tracks.length && job.tracks.every(t => t.status === 'done')) {
        job.status = 'done';
        job.finishedAt = new Date().toISOString();
      }
    }
    broadcast({ done: true });
  }
}

function buildArgs(job, track, withCookies) {
  const isVideo = Boolean(job.isVideo);
  const fmt = isVideo
    ? (VIDEO_FORMATS[job.format || '720p'] || VIDEO_FORMATS['720p'])
    : (FORMATS[job.format || 'mp3'] || FORMATS.mp3);
  const ext = fmt.ext ? `.${fmt.ext}` : '.%(ext)s';
  const name = job.single
    ? `%(title)s [%(id)s]${ext}`
    : `${String(track.index).padStart(job.pad || 2, '0')} - %(title)s${ext}`;
  const outTemplate = path.join(job.folder, name);
  const args = [
    ...fmt.args,
    ...(isVideo ? ['--merge-output-format', 'mp4'] : []),
    '--embed-thumbnail', '--embed-metadata',
    '--no-playlist', '--continue', '--ignore-errors',
    '--progress-template', 'PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${track.id}`
  ];
  if (withCookies) args.push(...cookieArgs());
  return { args, isVideo, fmt };
}

function formatSpeed(bytesPerSecond) {
  const n = Number(bytesPerSecond);
  if (!n || !isFinite(n)) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB/s`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB/s`;
  return `${n.toFixed(0)} B/s`;
}

function trackProgressParser(track) {
  let buffer = '';
  return (chunk, flush) => {
    buffer += chunk;
    let match;
    while ((match = /[\r\n]/.exec(buffer)) !== null) {
      const line = buffer.slice(0, match.index).trim();
      buffer = buffer.slice(match.index + 1);
      if (line) consumeLine(line);
    }
    if (flush && buffer.trim()) consumeLine(buffer.trim());
  };

  function consumeLine(line) {
    if (line.startsWith('PROGRESS|')) {
      const parts = line.split('|');
      const downloaded = Number(parts[1]) || 0;
      const total = Number(parts[2]) || 0;
      if (total > 0) {
        track.downloaded = downloaded;
        track.total = total;
        track.progress = Math.min(99, Math.round((downloaded / total) * 100));
        track.speed = formatSpeed(parts[3]);
        track.eta = parts[4] === 'NA' || !parts[4] ? null : Number(parts[4]);
        track.phase = 'downloading';
        const now = Date.now();
        if (!track.lastEmit || now - track.lastEmit > 220) {
          track.lastEmit = now;
          broadcast();
        }
      }
      return;
    }
    if (/\[(ExtractAudio|ffmpeg|EmbedThumbnail|Metadata)\]/.test(line)) {
      track.phase = 'processing';
      track.progress = 96;
      track.speed = '';
      track.eta = null;
      broadcast();
    }
  }
}

function friendlyError(stderr) {
  const text = String(stderr || '').trim();
  if (/could not copy chrome cookie|cookie database/i.test(text)) return 'Browser cookies were locked; try without browser sign-in';
  if (/sign in to confirm|not a bot/i.test(text)) return 'YouTube asked for a sign-in check';
  if (/private video/i.test(text)) return 'Video is private';
  if (/account associated with this video has been terminated/i.test(text)) return 'Uploader account is gone';
  if (/video unavailable/i.test(text)) return 'Video is unavailable';
  if (/http error 429|too many requests/i.test(text)) return 'YouTube throttled this request';
  return (text.split('\n').filter(l => /error/i.test(l)).pop() || 'Download failed').trim().slice(0, 120);
}

async function readTags(file) {
  try {
    const { stdout } = await execFileAsync(
      tools.ffprobe,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', file],
      { encoding: 'utf8', maxBuffer: 1e7, timeout: 30000, windowsHide: true }
    );
    const raw = safeJsonParse(stdout)?.format?.tags || {};
    // MP3/FLAC usually report lowercase keys; Matroska/WebM reports uppercase.
    const tags = {};
    for (const [key, value] of Object.entries(raw)) tags[String(key).toLowerCase()] = value;
    return tags;
  } catch { return {}; }
}

function normalizeArtist(raw, fallback) {
  let artist = String(raw || '').trim();
  if (!artist) return fallback || 'Unknown';
  const parts = [...new Set(artist.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean))];
  artist = parts.join(', ').replace(/\s*-\s*Topic$/i, '').trim();
  if (!artist || artist.length > 64) artist = parts[0] || fallback || 'Unknown';
  return artist;
}

async function writeTags(file, tags) {
  const safeTags = sanitizeTags(tags);
  if (!safeTags || !Object.keys(safeTags).length) throw new Error('No valid tags');
  if (!isMediaFile(file)) throw new Error('Only media files can be tagged');

  const id = randomUUID();
  const metaFile = path.join(os.tmpdir(), `snagly-meta-${id}.txt`);
  const extension = path.extname(file) || '.tmp';
  const outFile = path.join(os.tmpdir(), `snagly-out-${id}${extension}`);
  let content = ';FFMETADATA1\n';
  for (const [key, value] of Object.entries(safeTags)) {
    if (value) content += `${key}=${String(value)}\n`;
  }
  fs.writeFileSync(metaFile, content, 'utf8');
  try {
    await execFileAsync(
      tools.ffmpeg,
      ['-y', '-v', 'error', '-i', file, '-f', 'ffmetadata', '-i', metaFile,
        '-map', '0', '-map_metadata', '1', '-c', 'copy', outFile],
      { timeout: 120000, windowsHide: true, maxBuffer: 1e7 }
    );
    fs.copyFileSync(outFile, file);
  } finally {
    fs.rmSync(metaFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

function isLibraryPath(target) {
  const resolved = path.resolve(String(target || ''));
  if (isPathInside(state.root, resolved)) return true;
  return state.jobs.some(job => job.folder && isPathInside(job.folder, resolved));
}

async function editTags(file, tags) {
  const target = path.resolve(String(file || ''));
  if (!isLibraryPath(target)) throw new Error('File is outside the library');
  if (!isMediaFile(target)) throw new Error('Only media files can be tagged');
  if (!fs.existsSync(target)) throw new Error('File not found');
  return writeTags(target, tags);
}

function markCancelled(track) {
  track.status = 'cancelled';
  track.phase = 'cancelled';
  track.progress = 0;
  track.downloaded = 0;
  track.total = 0;
  track.speed = '';
  track.eta = null;
  track.error = 'Cancelled';
  broadcast();
}

async function processTrack(job, track) {
  if (track.cancelled) { markCancelled(track); return; }
  if (penaltyMs) await sleep(penaltyMs);
  await sleep(120 + Math.floor(Math.random() * 220));

  track.phase = 'preparing';
  track.progress = 0;
  track.warning = null;
  broadcast();

  const isVideo = Boolean(job.isVideo);
  const useCookies = state.useCookies && Boolean(cookieSource());
  const onStdout = trackProgressParser(track);
  const built = buildArgs(job, track, useCookies);
  let result = await runProcess(tools.yt, built.args, 600000, onStdout, track.id);
  noteThrottle(result.stderr);
  if (track.cancelled) { markCancelled(track); return; }

  const fmt = built.fmt;
  const ext = fmt.ext ? `.${fmt.ext}` : '';
  const locate = () => findTrackFile(job.folder, track.index, job.pad || 2, job.single, track.id, ext);
  let file = locate();
  if (result.code !== 0 && !file && useCookies) {
    const cookiesLocked = /could not copy chrome cookie|cookie database/i.test(result.stderr);
    const retryParser = trackProgressParser(track);
    const rebuilt = buildArgs(job, track, false);
    result = await runProcess(tools.yt, rebuilt.args, 600000, retryParser, track.id);
    noteThrottle(result.stderr);
    if (track.cancelled) { markCancelled(track); return; }
    file = locate();
    if (!track.cookieWarning) {
      track.cookieWarning = true;
      emit({
        type: 'notice',
        message: cookiesLocked
          ? 'Browser cookies were locked (is the browser running?). Continuing without sign-in. A cookies.txt file avoids this.'
          : 'Browser cookies were unavailable. Continuing without browser sign-in.'
      });
    }
  }

  // 4K fallback: if 4K requested but unavailable, retry with 1080p
  if (result.code !== 0 && !file && isVideo && job.format === '2160p' && !track.retried4kFallback) {
    track.retried4kFallback = true;
    const fallbackJob = { ...job, format: '1080p' };
    track.phase = '4K unavailable, retrying 1080p';
    broadcast();
    emit({ type: 'notice', message: '4K is not available for this video. Downloading in 1080p instead.' });
    await sleep(1000);
    return processTrack(fallbackJob, track);
  }

  if (result.code !== 0 && !file) {
    if (track.cancelled) { markCancelled(track); return; }
    if (track.retries < track.maxRetries) {
      track.retries++;
      track.status = 'queued';
      track.phase = `retrying (${track.retries}/${track.maxRetries})`;
      track.error = null;
      broadcast();
      await sleep(2000 * track.retries);
      return processTrack(job, track);
    }
    track.status = 'failed';
    track.phase = 'failed';
    track.error = friendlyError(result.stderr || result.stdout);
    return;
  }

  if (!file) {
    track.status = 'failed';
    track.phase = 'failed';
    track.error = isVideo ? 'yt-dlp finished but no video was written' : 'yt-dlp finished but no audio was written';
    return;
  }

  track.phase = 'processing';
  track.progress = 96;
  broadcast();

  const fullPath = path.join(job.folder, file);
  try {
    const tags = await readTags(fullPath);
    const artist = normalizeArtist(tags.artist, track.artist || job.title);
    const title = String(tags.title || track.title).trim();
    const album = job.albumTag || job.title;
    if (artist !== String(tags.artist || '') || !tags.album || tags.album !== album) {
      await writeTags(fullPath, {
        artist,
        'album artist': artist,
        album,
        title
      });
    }
    track.artist = artist;
    track.title = title;
  } catch (err) {
    track.warning = `Tags skipped: ${err.message}`;
  }

  try { track.size = fs.statSync(fullPath).size; } catch {}
  track.file = fullPath;
  track.completedAt = new Date().toISOString();
  track.status = 'done';
  track.phase = 'done';
  track.progress = 100;
  track.speed = '';
  track.eta = null;
  track.error = null;
  state.manifest[track.id] = { file: fullPath, title: track.title, artist: track.artist, jobId: job.id, completedAt: new Date().toISOString() };
}

function finalizeJob(job) {
  if (job.tracks.every(t => t.status === 'done')) {
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
  } else if (job.tracks.some(t => t.status === 'done') && job.tracks.every(t => t.status === 'done' || t.status === 'failed')) {
    job.status = 'partial';
    job.finishedAt = new Date().toISOString();
  } else if (job.tracks.every(t => t.status === 'failed')) {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
  }
}

function resetTrack(track) {
  track.status = 'queued';
  track.phase = null;
  track.progress = 0;
  track.downloaded = 0;
  track.total = 0;
  track.speed = '';
  track.eta = null;
  track.error = null;
  track.warning = null;
  track.cancelled = false;
  track.retries = 0;
}

function retryJob(jobId, trackId = null) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return false;
  let retried = 0;
  for (const t of job.tracks) {
    if (trackId && t.id !== trackId) continue;
    if (t.status === 'failed' || t.status === 'cancelled' || t.status === 'missing') {
      resetTrack(t);
      retried++;
    }
  }
  if (retried) {
    job.status = 'queued';
    job.finishedAt = null;
    saveState();
    broadcast();
    pump();
  }
  return retried;
}

function setPaused(value) {
  state.paused = Boolean(value);
  saveState();
  broadcast();
  if (!state.paused) pump();
}

function setWorkers(n) {
  state.workers = Math.max(1, Math.min(8, Number(n) || 5));
  saveState();
  broadcast();
  pump();
}

function setUseCookies(value) {
  state.useCookies = Boolean(value);
  saveState();
  broadcast();
}

function setIsVideo(value) {
  state.isVideo = Boolean(value);
  saveState();
  broadcast();
}

function removeJob(jobId) {
  const index = state.jobs.findIndex(j => j.id === jobId);
  if (index === -1) return 'missing';
  const job = state.jobs[index];
  // Never drop a job while a download is writing into its folder.
  if (job.tracks.some(t => t.status === 'running')) return 'running';
  state.jobs.splice(index, 1);
  for (const t of job.tracks) {
    if (state.manifest[t.id]?.jobId === job.id) delete state.manifest[t.id];
  }
  saveState();
  broadcast();
  return true;
}

function cancelJob(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return false;

  let cancelled = 0;
  for (const t of job.tracks) {
    if (t.status === 'running' || t.status === 'queued') {
      t.cancelled = true;
      const proc = runningProcesses.get(t.id);
      if (proc) { proc.kill(); runningProcesses.delete(t.id); }
      markCancelled(t);
      cancelled++;
    }
  }

  if (cancelled > 0) {
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    saveState();
    broadcast();
    pump();
  }
  return cancelled;
}

function shutdown() {
  for (const proc of runningProcesses.values()) {
    try { proc.kill(); } catch {}
  }
  runningProcesses.clear();
  if (libraryTimer) {
    clearInterval(libraryTimer);
    libraryTimer = null;
  }
  saveStateNow();
}

function clearCache() {
  let removed = 0;
  probeCache.clear();
  try {
    for (const entry of fs.readdirSync(CACHE_DIR)) {
      fs.rmSync(path.join(CACHE_DIR, entry), { recursive: true, force: true });
      removed++;
    }
  } catch {}
  return removed;
}

function getHistory() {
  const history = [];
  for (const job of state.jobs) {
    for (const t of job.tracks) {
      if (t.status === 'done' && t.file) {
        history.push({
          id: t.id,
          index: t.index,
          title: t.title,
          artist: t.artist,
          album: job.albumTag || job.title,
          file: t.file,
          size: t.size,
          completedAt: t.completedAt || job.finishedAt,
          jobId: job.id,
          jobTitle: job.title
        });
      }
    }
  }
  history.sort((a, b) => {
    const aa = new Date(a.completedAt || 0).getTime();
    const bb = new Date(b.completedAt || 0).getTime();
    return bb - aa;
  });
  return history;
}

function addSSE(res) {
  if (listeners.size >= MAX_SSE_CLIENTS) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Too many event streams');
    return;
  }
  listeners.add(res);
  res.write(': connected\n\n');
  broadcast();
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);
  res.on('close', () => { clearInterval(heartbeat); listeners.delete(res); });
}

function getStatus() {
  return {
    tools,
    root: state.root,
    collection: state.collection,
    format: state.format,
    isVideo: state.isVideo,
    workers: effectiveWorkers(),
    configuredWorkers: state.workers,
    useCookies: state.useCookies,
    cookieSource: cookieSource(),
    paused: state.paused,
    active: activeCount,
    penaltyMs,
    version: '1.1.0'
  };
}

// Windows-only: keep data/ readable only by this account (plus SYSTEM and
// Administrators, so backup/repair tools still work). This replaces explicitly
// granted broad ACEs too, which `icacls /inheritance:r` alone would leave in
// place. Silently skips FAT/exFAT and policies that ignore ACL changes.
const ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = $env:SNAGLY_ACL_PATH
$di = New-Object System.IO.DirectoryInfo($target)
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$prop = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
foreach ($sid in @($owner, $system, $admins)) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $prop, $allow)))
}
$di.SetAccessControl($acl)
`;

function restrictDataPermissions() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ACL_SCRIPT
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
      env: { ...process.env, SNAGLY_ACL_PATH: DATA_DIR }
    });
  } catch (err) {
    if (process.env.SNAGLY_DEBUG) {
      console.error('Snagly could not restrict data permissions:', err.stderr?.toString() || err.message);
    }
  }
}

function init() {
  loadState();
  restrictDataPermissions();
  discoverTools();
  reconcileLibrary(true);
  saveStateNow();
  startLibraryWatcher();
  pump();
}

// Save state before an unhandled crash so the library isn't lost on restart.
process.on('uncaughtException', err => {
  try { console.error('Snagly uncaught exception:', err); saveStateNow(); } catch {}
  process.exit(1);
});

process.on('unhandledRejection', err => {
  try { console.error('Snagly unhandled rejection:', err); saveStateNow(); } catch {}
});

module.exports = {
  init, getStatus, createJobs, previewSources, probeFormats, publicJobs, addSSE, retryJob, setPaused,
  setWorkers, setUseCookies, setIsVideo, removeJob, cancelJob, clearCache, getHistory, editTags,
  saveStateNow, pump, shutdown, tools: () => tools, reconcileLibrary, isLibraryPath, prepareRoot,
  dataDir: () => DATA_DIR, cookieSource,
  formats: () => Object.entries(FORMATS).map(([k, v]) => ({ key: k, ...v })),
  videoFormats: () => Object.entries(VIDEO_FORMATS).map(([k, v]) => ({ key: k, ...v })),
  _test: { sanitizeFolder, parseExtraction, findTrackFile, findExisting, buildArgs, prepareRoot, mediaMatcher, FORMATS, VIDEO_FORMATS }
};
