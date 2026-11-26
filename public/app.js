'use strict';

const $ = id => document.getElementById(id);

const ui = {
  urls: $('urls'),
  download: $('downloadButton'),
  savePath: $('savePath'),
  browse: $('browseButton'),

  formatSelect: $('formatSelect'),
  modeAudio: $('modeAudio'),
  modeVideo: $('modeVideo'),
  audioQualitySection: $('audioQualitySection'),
  videoQualitySection: $('videoQualitySection'),
  videoFormatSelect: $('videoFormatSelect'),
  videoQualityHint: $('videoQualityHint'),
  audioQualityHint: $('audioQualityHint'),
  activity: $('activity'),
  activityTitle: $('activityTitle'),
  activityCount: $('activityCount'),
  activityTotal: $('activityTotal'),
  activityTrack: $('activityTrack'),
  activityMeta: $('activityMeta'),
  pause: $('pauseButton'),
  wave: $('wave'),
  filmstrip: $('filmstrip'),
  emptyState: $('emptyState'),
  librarySummary: $('librarySummary'),
  toasts: $('toasts'),
  libraryMenuButton: $('libraryMenuButton'),
  libraryMenu: $('libraryMenu'),
  theme: $('themeButton'),
  hint: $('composerHint'),
  choose: $('chooseButton'),
  cookieToggle: $('cookieToggle'),
  selectionPanel: $('selectionPanel'),
  selectionSources: $('selectionSources'),
  selectionSummary: $('selectionSummary'),
  overallBar: $('overallBar'),
  activityPercent: $('activityPercent'),
  activeTracks: $('activeTracks'),
  librarySearch: $('librarySearch'),
  libraryFilter: $('libraryFilter'),
  librarySort: $('librarySort'),
  exportButton: $('exportButton'),
  clearCacheButton: $('clearCacheButton'),
  trackModal: $('trackModal'),
  modalClose: $('modalClose'),
  modalTitle: $('modalTitle'),
  modalArt: $('modalArt'),
  modalMeta: $('modalMeta'),
  modalBody: $('modalBody'),
  modalOpenFolder: $('modalOpenFolder'),
  modalYouTube: $('modalYouTube'),
  modalRetryAll: $('modalRetryAll'),
  modalCancel: $('modalCancel'),
  modalRemove: $('modalRemove'),
  confirmModal: $('confirmModal'),
  confirmTitle: $('confirmTitle'),
  confirmMessage: $('confirmMessage'),
  confirmAccept: $('confirmAcceptButton'),
  confirmCancel: $('confirmCancelButton'),
  cancelButton: $('cancelButton'),
  trackFilter: $('trackFilter'),
  rangeInput: $('rangeInput'),
  applyRange: $('applyRangeButton'),
  selectionDownload: $('selectionDownloadButton')
};

let status = { workers: 5, useCookies: true, paused: false, root: '', isVideo: false, tools: {} };
let jobs = [];
let previewData = null;
let previewSeq = 0;
let audioFormatList = null;
let videoFormatList = null;
let selected = [];
let sourceAudio = null;
let rowAnchors = new Map();
let lastFilmstripSig = '';
let renderQueued = false;
let openModalJobId = null;
let modalReturnFocus = null;
let confirmResolve = null;
let confirmReturnFocus = null;
let confirmPreviousOverflow = '';

const WAVE_HEIGHTS = [7, 13, 9, 18, 24, 15, 30, 21, 12, 26, 34, 19, 11, 28, 36, 22, 14, 31, 25, 16, 33, 20, 10, 27, 35, 17, 8, 23, 29, 13, 19, 32, 12, 24, 9, 16];

// Thumbnails come from YouTube. If one fails to load, hide it and reveal the
// letter placeholder where there is one. No inline handlers, so the CSP can
// stay strict.
document.addEventListener('error', event => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('thumb-img')) return;
  img.hidden = true;
  const fallback = img.nextElementSibling;
  if (fallback && fallback.classList.contains('placeholder')) fallback.hidden = false;
}, true);

let hadActiveJobs = false;
function maybeNotifyFinished() {
  const active = jobs.some(j => j.status === 'running' || j.status === 'queued');
  if (hadActiveJobs && !active && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const done = jobs.reduce((n, j) => n + j.done, 0);
    new Notification('Snagly finished', { body: `${done} track${done === 1 ? '' : 's'} in your library.`, silent: true });
  }
  hadActiveJobs = active;
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  ui.toasts.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s ease';
    setTimeout(() => el.remove(), 260);
  }, 4200);
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  }).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('reel-theme', theme);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#1C1C1E' : '#F5F5F7');
}

function initTheme() {
  const saved = localStorage.getItem('reel-theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (systemDark ? 'dark' : 'light'));
}

function buildWave() {
  ui.wave.innerHTML = '';
  for (const h of WAVE_HEIGHTS) {
    const bar = document.createElement('i');
    bar.style.height = `${h}px`;
    ui.wave.appendChild(bar);
  }
}

function renderSettings() {
  if (!ui.savePath.value) ui.savePath.value = status.root || '';
  if (status.format && !ui.formatSelect.value) {
    ui.formatSelect.value = status.format;
    ui.formatSelect._syncMenu?.();
  }
  if (ui.cookieToggle) {
    ui.cookieToggle.checked = status.useCookies !== false;
    ui.cookieToggle.disabled = !status.tools?.browser;
    ui.cookieToggle.closest('.cookie-toggle')?.classList.toggle('disabled', !status.tools?.browser);
  }
  ui.hint.textContent = status.tools?.yt && status.tools?.ffmpeg
    ? 'Runs on this computer. Only download audio you have rights to.'
    : 'Downloader tools were not found. Check the README for setup.';
}

function renderActivity() {
  const active = jobs.filter(j => j.status === 'running' || j.status === 'queued');
  if (!active.length) {
    ui.activity.hidden = true;
    return;
  }
  ui.activity.hidden = false;

  const total = active.reduce((n, j) => n + j.trackCount, 0);
  const done = active.reduce((n, j) => n + j.done, 0);
  const failed = active.reduce((n, j) => n + j.failed, 0);
  const runningTrack = active.flatMap(j => j.tracks).find(t => t.status === 'running');

  ui.activityTitle.textContent = active.length === 1 ? active[0].title : `${active.length} playlists`;
  ui.activityTrack.textContent = runningTrack
    ? `#${String(runningTrack.index).padStart(2, '0')} ${runningTrack.title}`
    : 'Preparing next track';

  const allTracks = active.flatMap(j => j.tracks);
  const partial = allTracks.reduce((n, t) => n + (t.status === 'done' ? 1 : (t.progress || 0) / 100), 0);
  const overall = total ? Math.min(100, Math.round((partial / total) * 100)) : 0;
  ui.activityPercent.textContent = `${overall}%`;
  ui.activityTotal.textContent = `(${done} of ${total})`;
  ui.overallBar.style.width = `${overall}%`;

  const bits = [`${overall}%`];
  if (status.active) bits.push(`${status.active} working`);
  if (failed) bits.push(`<span class="warn">${failed} failed</span>`);
  if (status.penaltyMs) bits.push('slowed to avoid throttling');
  ui.activityMeta.innerHTML = bits.join(', ');

  const bars = ui.wave.children;
  const filled = Math.round((overall / 100) * bars.length);
  for (let i = 0; i < bars.length; i++) {
    bars[i].classList.toggle('filled', i < filled);
    bars[i].classList.toggle('leading', !status.paused && i === filled && filled < bars.length);
  }

  const activeTracks = allTracks.filter(t => t.status === 'running').slice(0, 6);
  ui.activeTracks.innerHTML = activeTracks.map(t => {
    const phase = t.phase === 'processing' ? 'Tagging' : t.phase === 'preparing' ? 'Starting' : 'Downloading';
    const stats = [
      `${t.progress || 0}%`,
      t.speed && t.phase !== 'processing' ? t.speed : '',
      t.eta != null && t.phase !== 'processing' ? `${t.eta}s left` : ''
    ].filter(Boolean).join(', ');
    return `<div class="active-row">
      <span class="active-name">#${escapeHtml(String(t.index).padStart(2, '0'))} ${escapeHtml(t.title)}</span>
      <span class="active-stats">${escapeHtml(phase)}, ${escapeHtml(stats)}</span>
      <span class="active-bar"><span style="width:${t.progress || 0}%"></span></span>
    </div>`;
  }).join('');

  ui.pause.textContent = status.paused ? 'Resume' : 'Pause';
  const hasActive = jobs.some(j => j.status === 'running' || j.status === 'queued');
  ui.cancelButton.hidden = !hasActive;
}

function renderLibrary() {
  const list = filteredJobs();
  const sig = list.map(j => [j.id, j.title, j.thumb, j.trackCount, j.status].join('~')).join(';') + '|' + ui.librarySearch.value + '|' + ui.libraryFilter.value + '|' + ui.librarySort.value;
  if (sig !== lastFilmstripSig) {
    lastFilmstripSig = sig;
    ui.filmstrip.querySelectorAll('.tile').forEach(el => el.remove());
    ui.emptyState.hidden = list.length > 0;
    ui.filmstrip.insertAdjacentElement('beforeend', ui.emptyState);

    for (const job of list) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.job = job.id;
      tile.innerHTML = `
        <button class="tile-open" type="button">
          <span class="tile-art" aria-hidden="true">
            ${job.thumb ? `<img class="thumb-img" src="${escapeAttr(job.thumb)}" alt="" loading="lazy">` : ''}
            <span class="placeholder" ${job.thumb ? 'hidden' : ''}>${escapeHtml((job.title || '?').charAt(0))}</span>
            <span class="tile-progress"><span style="width:0%"></span></span>
          </span>
          <span class="tile-title" title="${escapeAttr(job.title)}">${escapeHtml(job.title)}</span>
        </button>
        <div class="tile-info">
          <div class="tile-meta"><span class="status-dot"></span><span class="tile-count"></span></div>
          <div class="tile-actions">
            <button type="button" data-action="open">Open folder</button>
            <button type="button" data-action="retry" hidden>Retry failed</button>
          </div>
        </div>`;
      ui.filmstrip.insertBefore(tile, ui.emptyState);
    }
  }

  const allDone = jobs.reduce((n, j) => n + j.done, 0);
  const allTracks = jobs.reduce((n, j) => n + j.trackCount, 0);
  ui.librarySummary.textContent = jobs.length ? `${jobs.length} playlist${jobs.length === 1 ? '' : 's'}, ${allDone} of ${allTracks} tracks` : '';

  for (const job of jobs) {
    const tile = ui.filmstrip.querySelector(`[data-job="${job.id}"]`);
    if (!tile) continue;
    const partial = job.tracks.reduce((n, t) => n + (t.status === 'done' ? 1 : (t.status === 'running' ? (t.progress || 0) / 100 : 0)), 0);
    const pct = job.trackCount ? Math.min(100, Math.round((partial / job.trackCount) * 100)) : 0;
    tile.querySelector('.tile-progress span').style.width = `${pct}%`;
    const dot = tile.querySelector('.status-dot');
    dot.className = `status-dot ${job.status}`;
    tile.querySelector('.tile-count').textContent = `${pct}% (${job.done}/${job.trackCount}${job.failed ? `, ${job.failed} failed` : ''}${job.cancelled ? `, ${job.cancelled} cancelled` : ''}${job.missing ? `, ${job.missing} missing` : ''})`;
    const retryButton = tile.querySelector('[data-action="retry"]');
    const retryable = (job.failed || 0) + (job.cancelled || 0) + (job.missing || 0);
    retryButton.hidden = retryable === 0;
    retryButton.textContent = (job.failed || job.cancelled) ? 'Retry failed' : 'Re-download missing';
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

function filteredJobs() {
  let list = jobs.slice();
  const q = ui.librarySearch.value.trim().toLowerCase();
  const f = ui.libraryFilter.value;
  if (q) list = list.filter(j => j.title.toLowerCase().includes(q));
  if (f !== 'all') list = list.filter(j => j.status === f);
  const s = ui.librarySort.value;
  list.sort((a, b) => {
    if (s === 'newest') return new Date(b.createdAt) - new Date(a.createdAt);
    if (s === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
    if (s === 'name') return a.title.localeCompare(b.title);
    if (s === 'tracks') return b.trackCount - a.trackCount;
    return 0;
  });
  return list;
}

function openTrackModal(jobId) {
  const job = jobs.find(j => j.id === jobId);
  if (!job) return;
  openModalJobId = jobId;
  ui.modalTitle.textContent = job.title;
  const thumb = job.thumb ? `<img class="thumb-img" src="${escapeAttr(job.thumb)}" alt="" loading="lazy">` : `<div class="placeholder" style="width:100%;height:100%;display:grid;place-items:center;font-size:42px;color:var(--faint);font-weight:600">${escapeHtml((job.title||'?').charAt(0))}</div>`;
  ui.modalArt.innerHTML = thumb;
  const done = job.tracks.filter(t => t.status === 'done').length;
  const failed = job.tracks.filter(t => t.status === 'failed').length;
  const cancelled = job.tracks.filter(t => t.status === 'cancelled').length;
  const missing = job.tracks.filter(t => t.status === 'missing').length;
  ui.modalMeta.innerHTML = `
    <span>${job.trackCount} ${job.isVideo ? 'video' : 'track'}${job.trackCount === 1 ? '' : 's'}</span>
    <span style="color:#34C759">${done} done</span>
    ${failed ? `<span style="color:var(--danger)">${failed} failed</span>` : ''}
    ${cancelled ? `<span style="color:var(--muted)">${cancelled} cancelled</span>` : ''}
    ${missing ? `<span style="color:var(--danger)">${missing} missing</span>` : ''}
    <span>${job.single ? 'Single video' : 'Playlist'}</span>
  `;
  ui.modalBody.innerHTML = job.tracks.map(t => {
    const pct = t.status === 'done' ? 100 : (t.progress || 0);
    const statusLabel = t.status === 'done' ? 'Done' : t.status === 'failed' ? 'Failed' : t.status === 'cancelled' ? 'Cancelled' : t.status === 'missing' ? 'Missing' : t.status === 'running' ? 'Downloading' : 'Queued';
    const baseActions = t.status === 'done'
      ? `<button class="text-button" data-action="open-file" data-track="${escapeAttr(t.id)}">Open file</button>`
      : t.status === 'failed' || t.status === 'cancelled' || t.status === 'missing'
        ? `<button class="text-button" data-action="retry-track" data-track="${escapeAttr(t.id)}">Retry</button>`
        : '';
    const editBtn = t.status === 'done'
      ? `<button class="text-button" data-action="edit-tags" data-track="${escapeAttr(t.id)}">Edit tags</button>`
      : '';
    return `<div class="track-detail" data-track="${escapeAttr(t.id)}">
      <div class="track-name" style="flex:1; min-width:0; position:relative;">
        <div style="font-weight:600" data-field="title">${escapeHtml(t.title)}</div>
        <div style="font-size:11px;color:var(--faint)" data-field="artist">${escapeHtml(t.artist)}, #${String(t.index).padStart(2,'0')}</div>
        <input type="text" data-edit="title" value="${escapeAttr(t.title)}" hidden style="width:100%;font-size:13px;font-weight:600;border:1px solid var(--hairline);border-radius:4px;padding:2px 6px;background:var(--surface)">
        <input type="text" data-edit="artist" value="${escapeAttr(t.artist)}" hidden style="width:100%;font-size:11px;color:var(--faint);border:1px solid var(--hairline);border-radius:4px;padding:1px 6px;background:var(--surface);margin-top:2px">
      </div>
      <div class="track-status">${statusLabel}</div>
      <div class="track-bar"><span style="width:${pct}%"></span></div>
      ${t.error ? `<div class="track-error">${escapeHtml(t.error)}</div>` : ''}
      ${t.warning ? `<div class="track-warning">${escapeHtml(t.warning)}</div>` : ''}
      <div class="track-actions">${baseActions}${editBtn}
        <button class="text-button" data-action="save-tags" data-track="${escapeAttr(t.id)}" hidden>Save</button>
        <button class="text-button" data-action="cancel-edit" data-track="${escapeAttr(t.id)}" hidden>Cancel</button>
      </div>
    </div>`;
  }).join('');
  ui.modalOpenFolder.dataset.job = jobId;
  ui.modalRetryAll.dataset.job = jobId;
  ui.modalRemove.dataset.job = jobId;
  const isActive = job.status === 'running' || job.status === 'queued';
  ui.modalCancel.hidden = !isActive;
  ui.modalCancel.dataset.job = jobId;
  ui.modalRemove.hidden = isActive;
  modalReturnFocus = document.activeElement;
  ui.trackModal.hidden = false;
  ui.trackModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  ui.modalClose.focus();
}

function closeTrackModal() {
  ui.trackModal.hidden = true;
  ui.trackModal.setAttribute('aria-hidden', 'true');
  openModalJobId = null;
  document.body.style.overflow = '';
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function askConfirm({ title, message, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false }) {
  if (confirmResolve) settleConfirm(false);
  return new Promise(resolve => {
    confirmResolve = resolve;
    confirmReturnFocus = document.activeElement;
    confirmPreviousOverflow = document.body.style.overflow;
    ui.confirmTitle.textContent = title;
    ui.confirmMessage.textContent = message;
    ui.confirmAccept.querySelector('.button-label').textContent = confirmLabel;
    ui.confirmCancel.textContent = cancelLabel;
    ui.confirmAccept.classList.toggle('danger', danger);
    ui.confirmModal.hidden = false;
    ui.confirmModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    ui.confirmCancel.focus();
  });
}

function settleConfirm(value) {
  if (!confirmResolve) return;
  const resolve = confirmResolve;
  confirmResolve = null;
  ui.confirmModal.hidden = true;
  ui.confirmModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = confirmPreviousOverflow;
  const returnTarget = confirmReturnFocus;
  confirmReturnFocus = null;
  if (returnTarget && document.contains(returnTarget)) returnTarget.focus();
  resolve(value);
}

ui.confirmAccept.addEventListener('click', () => settleConfirm(true));
ui.confirmCancel.addEventListener('click', () => settleConfirm(false));
ui.confirmModal.addEventListener('click', event => {
  if (event.target === ui.confirmModal) settleConfirm(false);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !ui.confirmModal.hidden) {
    event.preventDefault();
    settleConfirm(false);
    return;
  }
  if (event.key === 'Tab' && !ui.confirmModal.hidden) {
    const first = ui.confirmCancel;
    const last = ui.confirmAccept;
    if (!ui.confirmModal.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  if (event.key === 'Escape' && !ui.trackModal.hidden) {
    event.preventDefault();
    closeTrackModal();
  }
});

function csvCell(value) {
  let text = String(value ?? '');
  // Stop spreadsheet formula injection in exported titles and paths.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportHistory() {
  const history = [];
  for (const job of jobs) {
    for (const t of job.tracks) {
      if (t.status === 'done' && t.file) {
        history.push({ title: t.title, artist: t.artist, album: job.albumTag || job.title, file: t.file, completedAt: t.completedAt || job.finishedAt });
      }
    }
  }
  history.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  const csv = ['title,artist,album,file,completedAt\n']
    .concat(history.map(h => [h.title, h.artist, h.album, h.file, h.completedAt].map(csvCell).join(',')))
    .join('');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `snagly-history-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${history.length} tracks.`);
}

function parseRange(text, max) {
  const result = new Set();
  for (const part of String(text || '').split(',')) {
    const token = part.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= max) result.add(i);
    } else {
      const n = Number(token);
      if (Number.isInteger(n) && n >= 1 && n <= max) result.add(n);
    }
  }
  return result;
}

function updateSelectionSummary() {
  const total = previewData?.sources.reduce((n, s) => n + s.entries.length, 0) || 0;
  const chosen = selected.reduce((n, set) => n + set.size, 0);
  ui.selectionSummary.textContent = `${chosen} of ${total} selected`;
  updateDownloadButton();
}

function setChooseLabel(text) {
  const label = ui.choose.querySelector('.disclosure-label');
  if (label) label.textContent = text;
  else ui.choose.textContent = text;
}

function setChooseOpen(open) {
  ui.choose.setAttribute('aria-expanded', String(open));
}

function downloadButtons() {
  return [ui.download, ui.selectionDownload].filter(Boolean);
}

function setDownloadLabel(text) {
  for (const button of downloadButtons()) {
    button.querySelector('.button-label').textContent = text;
  }
}

function setDownloadBusy(busy) {
  for (const button of downloadButtons()) {
    button.disabled = busy;
    button.classList.toggle('loading', busy);
  }
}

// The panel has its own button so the action is reachable while the track
// list is scrolled. Only one of the two buttons is visible at a time.
function updateDownloadButton() {
  const total = previewData?.sources.reduce((n, s) => n + s.entries.length, 0) || 0;
  const chosen = selected.reduce((n, set) => n + set.size, 0);
  const noun = status.isVideo ? 'video' : 'track';
  setDownloadLabel(total > 0 ? `Download ${chosen} ${noun}${chosen === 1 ? '' : 's'}` : 'Download');

  const panelOpen = !ui.selectionPanel.hidden;
  ui.download.hidden = panelOpen;

  const noneSelected = total > 0 && chosen === 0;
  ui.selectionDownload.disabled = noneSelected;
  ui.download.disabled = noneSelected;
}

const VIDEO_LADDER = [2160, 1440, 1080, 720, 480, 360];
const VIDEO_LABELS = {
  2160: '4K MP4 (2160p)',
  1440: '1440p MP4',
  1080: '1080p MP4',
  720: '720p MP4',
  480: '480p MP4',
  360: '360p MP4'
};

// What each audio preset actually asks the encoder for. FLAC is lossless, so
// any lossy source is below it by definition.
const AUDIO_TARGET_KBPS = { mp3: 320, mp3v0: 245, m4a: 256, opus: 160, flac: Infinity, best: 0 };

function updateAudioHint() {
  if (!sourceAudio) {
    ui.audioQualityHint.textContent = 'Quality follows the source';
    ui.audioQualityHint.removeAttribute('title');
    return;
  }
  const target = AUDIO_TARGET_KBPS[ui.formatSelect.value] ?? 0;
  ui.audioQualityHint.textContent = target > sourceAudio.kbps
    ? `Source is ${sourceAudio.codec} ${sourceAudio.kbps} kbps. Higher bitrates only make larger files.`
    : `Source audio: ${sourceAudio.codec} ${sourceAudio.kbps} kbps`;
  ui.audioQualityHint.title = sourceAudio.kbps < 320
    ? 'This is the source ceiling. Higher bitrates are upsampled, not more detailed.'
    : 'This is the best audio these links offer.';
}

// Trim the quality menus to what the pasted links actually offer.
function applySourceFormats(sources) {
  const probes = (sources || []).map(s => s.formats).filter(Boolean);
  if (!probes.length) {
    ui.videoQualityHint.textContent = 'Video + audio, source quality';
    sourceAudio = null;
    updateAudioHint();
    return;
  }

  // Video is a ceiling, so every rung up to the tallest source is usable.
  const maxHeight = Math.max(...probes.map(p => p.maxHeight || 0));
  const heights = VIDEO_LADDER.filter(h => h <= maxHeight);
  if (heights.length) {
    const current = Number(String(ui.videoFormatSelect.value || '').replace('p', ''));
    const fallback = heights.includes(1080) ? 1080 : (heights.find(h => h < 1080) || heights[0]);
    const keep = heights.includes(current) ? current : fallback;
    ui.videoFormatSelect.innerHTML = heights
      .map(h => `<option value="${h}p">${VIDEO_LABELS[h]}</option>`).join('');
    ui.videoFormatSelect.value = `${keep}p`;
    ui.videoFormatSelect._syncMenu?.();
  } else if (maxHeight > 0) {
    // 240p and below: no ladder rung fits, so name the real ceiling instead
    // of leaving the full menu on screen.
    ui.videoFormatSelect.innerHTML = `<option value="source">Source quality (${maxHeight}p)</option>`;
    ui.videoFormatSelect.value = 'source';
    ui.videoFormatSelect._syncMenu?.();
  }
  ui.videoQualityHint.textContent = heights.length
    ? `Video + audio, up to ${maxHeight >= 2160 ? '4K' : `${maxHeight}p`}`
    : maxHeight > 0
      ? `Video + audio, source quality (${maxHeight}p)`
      : 'Video + audio, source quality';

  const audio = probes.map(p => p.audio).filter(a => a && a.kbps);
  const bestAudio = audio.sort((a, b) => b.kbps - a.kbps)[0];
  const bestOption = ui.formatSelect.querySelector('option[value="best"]');
  if (bestOption) {
    bestOption.textContent = bestAudio
      ? `Best available (${bestAudio.codec} ${bestAudio.kbps} kbps)`
      : 'Best available (original)';
    ui.formatSelect._syncMenu?.();
  }
  sourceAudio = bestAudio || null;
  updateAudioHint();
}

function resetSourceFormats() {
  ui.videoQualityHint.textContent = 'Video + audio, source quality';
  sourceAudio = null;
  updateAudioHint();
  // Rebuild from the cached lists synchronously. Fetching here let a slow
  // response overwrite the trimmed list a completed probe had just applied.
  if (videoFormatList) renderVideoFormatList(videoFormatList);
  else loadVideoFormats();
  if (audioFormatList) renderAudioFormatList(audioFormatList);
  else loadFormats();
}

function renderSelection() {
  if (!previewData) return;
  updateSelectionSummary();
  ui.selectionSources.innerHTML = previewData.sources.map((source, si) => {
    const all = selected[si].size === source.entries.length;
    const multi = source.entries.length > 1;
    const noun = status.isVideo ? 'video' : 'track';
    const metaLabel = source.single
      ? 'Single video'
      : `${source.entries.length} ${noun}${source.entries.length === 1 ? '' : 's'}`;
    const mix = /[?&]list=RD/i.test(source.url || '');
    const large = !mix && source.entries.length > 50;
    const banner = mix
      ? 'This is a YouTube Mix, not a fixed playlist.'
      : large
        ? `Large playlist: ${source.entries.length} tracks.`
        : '';
    return `
    <div class="source-group" data-source="${si}">
      <div class="source-head">
        ${source.thumb ? `<img class="thumb-img" src="${escapeAttr(source.thumb)}" alt="">` : ''}
        <div>
          <strong title="${escapeAttr(source.title)}">${escapeHtml(source.title)}</strong>
          <span class="source-meta" data-count="${source.entries.length}" data-single="${source.single ? '1' : '0'}" data-cached="${source.cached ? '1' : '0'}">${metaLabel}${source.cached ? ' (cached)' : ''}</span>
        </div>
        ${multi ? `<input class="source-check" type="checkbox" ${all ? 'checked' : ''} aria-label="${all ? 'Deselect' : 'Select'} all ${noun}s">` : ''}
      </div>
      ${banner ? `<div class="source-banner">
        <span>${banner}</span>
        <button class="quiet-button source-banner-button" type="button" data-select-all="${si}" ${all ? 'hidden' : ''}>Select all ${source.entries.length}</button>
      </div>` : ''}
      <div class="track-list">
        ${source.entries.map(e => `
          <div class="track-row ${selected[si].has(e.index) ? 'checked' : ''}" role="checkbox" tabindex="0" aria-checked="${selected[si].has(e.index)}" data-index="${e.index}">
            <input type="checkbox" data-index="${e.index}" tabindex="-1" aria-hidden="true" ${selected[si].has(e.index) ? 'checked' : ''}>
            <span class="track-num">${String(e.index).padStart(2, '0')}</span>
            <span class="track-name" title="${escapeAttr(e.title)}">${escapeHtml(e.title)}</span>
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
  previewData.sources.forEach((_, si) => updateGroupBadges(si));
  applyTrackFilter();
}

function updateGroupBadges(si) {
  const source = previewData?.sources[si];
  const group = ui.selectionSources.querySelector(`.source-group[data-source="${si}"]`);
  if (!source || !group) return;
  const all = selected[si].size === source.entries.length;
  const bannerButton = group.querySelector('[data-select-all]');
  if (bannerButton) bannerButton.hidden = all;
  const checkbox = group.querySelector('.source-check');
  if (!checkbox) return;
  const some = selected[si].size > 0 && !all;
  checkbox.checked = all;
  checkbox.indeterminate = some;
  checkbox.setAttribute('aria-label', `${all ? 'Deselect' : 'Select'} all ${status.isVideo ? 'videos' : 'tracks'}`);
}

// Update one source in place. Rebuilding the whole panel on every All/Clear
// reset the scroll position and made large playlists feel stuck.
function syncGroupSelection(si) {
  const source = previewData?.sources[si];
  const group = ui.selectionSources.querySelector(`.source-group[data-source="${si}"]`);
  if (!source || !group) return;
  group.querySelectorAll('.track-row').forEach(row => {
    const input = row.querySelector('input[type="checkbox"]');
    const on = selected[si].has(Number(input.dataset.index));
    input.checked = on;
    row.classList.toggle('checked', on);
    row.setAttribute('aria-checked', String(on));
  });
  updateGroupBadges(si);
}

function applyTrackFilter() {
  const query = ui.trackFilter.value.trim().toLowerCase();
  ui.selectionSources.querySelectorAll('.source-group').forEach(group => {
    let visible = 0;
    group.querySelectorAll('.track-row').forEach(row => {
      const match = !query || row.querySelector('.track-name').textContent.toLowerCase().includes(query);
      row.hidden = !match;
      if (match) visible++;
    });
    group.classList.toggle('filter-empty', Boolean(query) && visible === 0);
  });
}

async function previewLinks() {
  const urls = ui.urls.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!urls.length) {
    toast('Paste at least one link first.', 'error');
    ui.urls.focus();
    return;
  }
  const seq = ++previewSeq;
  ui.choose.disabled = true;
  setChooseLabel('Reading links…');
  try {
    const result = await api('/api/preview', { method: 'POST', body: JSON.stringify({ urls }) });
    if (seq !== previewSeq) return;

    previewData = result;
    // A Mix is a moving target, and very large playlists are easy to start by
    // accident. Both open with the first 25 items instead of everything.
    selected = result.sources.map(s => {
      const limited = /[?&]list=RD/i.test(s.url || '') || s.entries.length > 50;
      return new Set((limited ? s.entries.slice(0, 25) : s.entries).map(e => e.index));
    });
    rowAnchors.clear();
    ui.trackFilter.value = '';
    renderSelection();

    const total = result.sources.reduce((n, s) => n + s.entries.length, 0);
    const compact = result.sources.length > 0 && total <= 1;
    ui.choose.hidden = compact;
    ui.selectionPanel.hidden = compact || result.sources.length === 0;
    setChooseOpen(!ui.selectionPanel.hidden);
    ui.trackFilter.hidden = total <= 8;
    setChooseLabel('Choose tracks');
    updateDownloadButton();

    for (const err of result.errors || []) toast(`Could not read that link: ${err.error}`, 'error');

    if (!result.sources.some(s => s.formats)) resetSourceFormats();
    else applySourceFormats(result.sources);

    const pending = result.sources.filter(s => !s.formats);
    if (pending.length) {
      ui.audioQualityHint.textContent = 'Checking source quality…';
      if (!ui.videoQualitySection.hidden) ui.videoQualityHint.textContent = 'Checking source quality…';
      detectFormats(result, seq);
    }
  } catch (err) {
    if (seq !== previewSeq) return;
    toast(err.message, 'error');
    setChooseLabel('Choose tracks');
  } finally {
    if (seq === previewSeq) ui.choose.disabled = false;
  }
}

// The track list is already usable; formats arrive a few seconds later and
// only change the quality menus. Probing spawns yt-dlp, so keep a small cap
// instead of firing one process per pasted link.
async function detectFormats(result, seq) {
  const pending = result.sources.filter(s => !s.formats);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (cursor < pending.length) {
      const source = pending[cursor++];
      let formats = null;
      try {
        const data = await api('/api/probe', { method: 'POST', body: JSON.stringify({ url: source.url }) });
        formats = data.formats || null;
      } catch { /* leave the source untouched */ }
      // Show quality as soon as a probe lands instead of waiting for every
      // pasted link to finish. Failures leave the hint alone.
      if (formats && previewData === result && seq === previewSeq) {
        source.formats = formats;
        applySourceFormats(result.sources);
      }
    }
  });
  await Promise.all(workers);
  if (previewData === result && seq === previewSeq) applySourceFormats(result.sources);
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderSettings();
    renderActivity();
    renderLibrary();
    maybeNotifyFinished();
  });
}

async function refresh() {
  try {
    const data = await api('/api/jobs');
    jobs = data.jobs || [];
    status = data.status || status;
    scheduleRender();
  } catch (err) {
    toast(`Could not reach Snagly: ${err.message}`, 'error');
  }
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.onmessage = event => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'notice') {
        toast(payload.message);
        return;
      }
      if (payload.type !== 'state') return;
      jobs = payload.jobs || jobs;
      status = { ...status, paused: payload.paused, workers: payload.workers, active: payload.active, penaltyMs: payload.penaltyMs, isVideo: payload.isVideo };
      scheduleRender();
      if (payload.libraryRemoved) {
        toast(`${payload.libraryRemoved} librar${payload.libraryRemoved === 1 ? 'y entry' : 'y entries'} removed. The folder was deleted on disk.`);
      }
    } catch {}
  };
  source.onerror = () => {
    source.close();
    setTimeout(connectEvents, 1500);
  };
}

async function submitJobs(payload) {
  let result = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
  const duplicates = (result.errors || []).filter(error => error.duplicate);
  if (duplicates.length && !payload.allowDuplicate) {
    const confirmed = await askConfirm({
      title: 'Already in library',
      message: `${duplicates.length} link${duplicates.length === 1 ? ' is' : 's are'} already in your library. Add ${duplicates.length === 1 ? 'it' : 'them'} again?`,
      confirmLabel: 'Add anyway',
      cancelLabel: 'Skip'
    });
    if (confirmed) {
      result = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ ...payload, allowDuplicate: true }) });
    }
  }
  return result;
}

async function startDownload() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  const urls = ui.urls.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!urls.length) {
    toast('Paste at least one playlist link first.', 'error');
    ui.urls.focus();
    return;
  }

  const hasPreview = Boolean(previewData?.sources.length);

  // A preview means the user has seen the track list. Download the tracks
  // they kept selected, whether the list is open or not.
  if (hasPreview) {
    const isVideo = ui.modeVideo.classList.contains('active');
    const items = previewData.sources
      .map((source, si) => ({ url: source.url, selected: [...selected[si]] }))
      .filter(item => item.selected.length);
    if (!items.length) {
      toast('Select at least one track.', 'error');
      return;
    }
    const chosen = items.reduce((n, item) => n + item.selected.length, 0);
    if (chosen > 100) {
      const noun = isVideo ? 'videos' : 'tracks';
      const confirmed = await askConfirm({
        title: `Download ${chosen} ${noun}?`,
        message: 'This will start a large batch.',
        confirmLabel: 'Download',
        cancelLabel: 'Cancel'
      });
      if (!confirmed) return;
    }
    setDownloadBusy(true);
    setDownloadLabel('Preparing…');
    try {
      const fmt = isVideo ? ui.videoFormatSelect.value : ui.formatSelect.value;
      const result = await submitJobs({
        items,
        root: ui.savePath.value.trim(),
        format: fmt,
        isVideo
      });
      if (result.created?.length) {
        ui.urls.value = '';
        ui.selectionPanel.hidden = true;
        setChooseOpen(false);
        previewData = null;
        selected = [];
        rowAnchors.clear();
        setChooseLabel('Choose tracks');
        ui.choose.hidden = false;
        ui.trackFilter.hidden = true;
        updateDownloadButton();
        toast(`Downloading ${result.created.reduce((n, j) => n + j.trackCount, 0)} selected track${result.created.length === 1 ? '' : 's'}.`);
      }
      for (const err of result.errors || []) toast(`Could not start that link: ${err.error}`, 'error');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setDownloadBusy(false);
      updateDownloadButton();
    }
    return;
  }

  // Otherwise: download all URLs
  setDownloadBusy(true);
  setDownloadLabel('Preparing…');
  try {
    const isVideo = ui.modeVideo.classList.contains('active');
    const fmt = isVideo ? ui.videoFormatSelect.value : ui.formatSelect.value;
    const result = await submitJobs({
      urls,
      root: ui.savePath.value.trim(),
      format: fmt,
      isVideo
    });
    if (result.created?.length) {
      ui.urls.value = '';
      toast(`Added ${result.created.length} playlist${result.created.length === 1 ? '' : 's'}. ${isVideo ? 'Downloading video' : 'Downloading audio'} now.`);
    }
    for (const err of result.errors || []) {
      toast(`Could not read that playlist: ${err.error}`, 'error');
    }
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setDownloadBusy(false);
    updateDownloadButton();
  }
}

async function postSettings(patch) {
  try {
    status = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
    scheduleRender();
  } catch (err) { toast(err.message, 'error'); }
}

ui.download.addEventListener('click', startDownload);
ui.selectionDownload.addEventListener('click', startDownload);
ui.urls.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') startDownload();
});
let previewDebounce = null;
// Avoid firing yt-dlp for half-typed links. Only a complete video, playlist,
// or shorts URL is worth a round trip.
function hasCompleteYouTubeLink(text) {
  return /(?:youtu\.be\/[\w-]{11})|(?:youtube\.com\/shorts\/[\w-]{11})|(?:youtube\.com\/(?:watch|playlist)\?(?:[^\s]*[?&])?(?:v|list)=[\w-]{11})/i.test(text);
}
ui.urls.addEventListener('input', () => {
  previewSeq++;
  previewData = null;
  selected = [];
  rowAnchors.clear();
  ui.selectionPanel.hidden = true;
  setChooseOpen(false);
  ui.choose.disabled = false;
  setChooseLabel('Choose tracks');
  ui.choose.hidden = false;
  ui.trackFilter.hidden = true;
  updateDownloadButton();
  clearTimeout(previewDebounce);
  const urls = ui.urls.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!urls.length) {
    resetSourceFormats();
    return;
  }
  if (!hasCompleteYouTubeLink(ui.urls.value)) return;
  previewDebounce = setTimeout(() => {
    previewLinks();
  }, 300);
});

// Drop a link (or selected text) anywhere on the composer to add it.
function addDroppedLinks(event) {
  event.preventDefault();
  ui.urls.classList.remove('drag');
  const data = event.dataTransfer;
  if (!data) return;
  const text = (data.getData('text/uri-list') || data.getData('text/plain') || '').trim();
  if (!text) return;
  const existing = ui.urls.value.trim();
  ui.urls.value = existing ? `${existing}\n${text}` : text;
  ui.urls.dispatchEvent(new Event('input'));
  ui.urls.focus();
}
ui.urls.addEventListener('dragover', event => {
  event.preventDefault();
  ui.urls.classList.add('drag');
});
ui.urls.addEventListener('dragleave', () => ui.urls.classList.remove('drag'));
ui.urls.addEventListener('drop', addDroppedLinks);

ui.browse.addEventListener('click', async () => {
  ui.browse.disabled = true;
  try {
    // The browser's showDirectoryPicker() only exposes a folder *name*, not an
    // absolute path, and the server is what writes the files. Use the native
    // Windows picker on the server instead.
    const result = await api('/api/browse', {
      method: 'POST',
      body: JSON.stringify({ path: ui.savePath.value.trim() })
    });
    if (result.path) {
      ui.savePath.value = result.path;
      toast(`Saving to ${result.path}`);
    } else if (result.error) {
      toast(result.error, 'error');
    }
  } catch (err) { toast(err.message, 'error'); }
  finally { ui.browse.disabled = false; }
});

ui.choose.addEventListener('click', () => {
  if (!ui.selectionPanel.hidden) {
    ui.selectionPanel.hidden = true;
    setChooseOpen(false);
    updateDownloadButton();
    return;
  }
  if (previewData?.sources.length) {
    ui.selectionPanel.hidden = false;
    setChooseOpen(true);
    updateDownloadButton();
    return;
  }
  previewLinks();
});

function setSourceSelection(si, indexes) {
  const source = previewData?.sources[si];
  if (!source) return;
  selected[si] = new Set(indexes);
  syncGroupSelection(si);
  updateSelectionSummary();
}

ui.selectionSources.addEventListener('change', event => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.classList.contains('source-check')) return;
  const group = input.closest('.source-group');
  const si = Number(group?.dataset.source);
  const source = previewData?.sources[si];
  if (!source) return;
  setSourceSelection(si, input.checked ? source.entries.map(e => e.index) : []);
});

function toggleRow(si, source, index, shiftKey) {
  const positions = source.entries.map(entry => entry.index);
  const target = !selected[si].has(index);
  if (shiftKey && rowAnchors.has(si)) {
    const clicked = positions.indexOf(index);
    const anchor = positions.indexOf(rowAnchors.get(si));
    if (anchor >= 0 && clicked >= 0) {
      const from = Math.min(anchor, clicked);
      const to = Math.max(anchor, clicked);
      for (let p = from; p <= to; p++) {
        if (target) selected[si].add(positions[p]);
        else selected[si].delete(positions[p]);
      }
    } else if (target) selected[si].add(index);
    else selected[si].delete(index);
  } else if (target) selected[si].add(index);
  else selected[si].delete(index);
  rowAnchors.set(si, index);
  syncGroupSelection(si);
  updateSelectionSummary();
}

ui.selectionSources.addEventListener('click', event => {
  const selectAll = event.target.closest('[data-select-all]');
  if (selectAll) {
    const si = Number(selectAll.dataset.selectAll);
    const source = previewData?.sources[si];
    if (source) setSourceSelection(si, source.entries.map(e => e.index));
    return;
  }

  const row = event.target.closest('.track-row');
  if (!row) return;
  event.preventDefault();
  const si = Number(row.closest('.source-group')?.dataset.source);
  const source = previewData?.sources[si];
  if (!source) return;
  const index = Number(row.dataset.index);
  if (event.detail !== 0) row.focus({ preventScroll: true });
  toggleRow(si, source, index, event.shiftKey);
});

ui.selectionSources.addEventListener('keydown', event => {
  const row = event.target.closest?.('.track-row');
  if (!row || event.target !== row) return;
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  const si = Number(row.closest('.source-group')?.dataset.source);
  const source = previewData?.sources[si];
  if (!source) return;
  toggleRow(si, source, Number(row.dataset.index), false);
});

function applyRangeSelection() {
  if (!previewData?.sources.length) return;
  const text = ui.rangeInput.value;
  selected = previewData.sources.map(source => parseRange(text, source.entries.length));
  rowAnchors.clear();
  previewData.sources.forEach((_, si) => syncGroupSelection(si));
  updateSelectionSummary();
}

ui.applyRange.addEventListener('click', applyRangeSelection);
ui.rangeInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    applyRangeSelection();
  }
});

ui.trackFilter.addEventListener('input', applyTrackFilter);
ui.formatSelect.addEventListener('change', updateAudioHint);

ui.theme.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

ui.cookieToggle?.addEventListener('change', () => {
  postSettings({ useCookies: ui.cookieToggle.checked });
});

ui.pause.addEventListener('click', async () => {
  try {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: !status.paused }) });
    await refresh();
  } catch (err) { toast(err.message, 'error'); }
});

ui.filmstrip.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.closest('.tile')?.dataset.job;
  const job = jobs.find(j => j.id === id);
  if (!job) return;
  if (button.dataset.action === 'open') {
    try { await api('/api/open', { method: 'POST', body: JSON.stringify({ path: job.folder }) }); }
    catch (err) { toast(err.message, 'error'); }
  }
  if (button.dataset.action === 'retry') {
    try {
      const result = await api(`/api/jobs/${id}/retry`, { method: 'POST', body: '{}' });
      toast(`Retrying ${result.retried} track${result.retried === 1 ? '' : 's'}.`);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }
});

ui.filmstrip.addEventListener('click', event => {
  const tile = event.target.closest('.tile');
  if (!tile) return;
  if (event.target.closest('button[data-action]')) return;
  openTrackModal(tile.dataset.job);
});

// Modal
ui.modalClose.addEventListener('click', closeTrackModal);
ui.trackModal.addEventListener('click', event => {
  if (event.target === ui.trackModal) closeTrackModal();
});

ui.modalOpenFolder.addEventListener('click', async () => {
  const job = jobs.find(j => j.id === openModalJobId);
  if (!job) return;
  try { await api('/api/open', { method: 'POST', body: JSON.stringify({ path: job.folder }) }); }
  catch (err) { toast(err.message, 'error'); }
});

ui.modalYouTube.addEventListener('click', () => {
  const job = jobs.find(j => j.id === openModalJobId);
  if (!job) return;
  const url = job.single ? job.url : `https://www.youtube.com/playlist?list=${encodeURIComponent(job.playlistId || '')}`;
  window.open(url, '_blank', 'noopener');
});

ui.modalRetryAll.addEventListener('click', async () => {
  if (!openModalJobId) return;
  try {
    const result = await api(`/api/jobs/${openModalJobId}/retry`, { method: 'POST', body: '{}' });
    toast(`Retrying ${result.retried} track${result.retried === 1 ? '' : 's'}.`);
    closeTrackModal();
    await refresh();
  } catch (err) { toast(err.message, 'error'); }
});

ui.modalCancel.addEventListener('click', async () => {
  if (!openModalJobId) return;
  const confirmed = await askConfirm({
    title: 'Cancel this download?',
    message: 'Finished tracks stay on disk.',
    confirmLabel: 'Cancel download',
    cancelLabel: 'Keep downloading',
    danger: true
  });
  if (!confirmed) return;
  try {
    const result = await api(`/api/jobs/${openModalJobId}/cancel`, { method: 'POST', body: '{}' });
    toast(`Cancelled ${result.cancelled} track${result.cancelled === 1 ? '' : 's'}.`);
    closeTrackModal();
    await refresh();
  } catch (err) { toast(err.message, 'error'); }
});

ui.modalRemove.addEventListener('click', async () => {
  if (!openModalJobId) return;
  const confirmed = await askConfirm({
    title: 'Remove from library?',
    message: 'Downloaded files stay on disk.',
    confirmLabel: 'Remove',
    cancelLabel: 'Keep',
    danger: true
  });
  if (!confirmed) return;
  try {
    const ok = await api(`/api/jobs/${openModalJobId}`, { method: 'DELETE' });
    if (ok.ok) {
      closeTrackModal();
      await refresh();
      toast('Removed from library.');
    }
  } catch (err) { toast(err.message, 'error'); }
});

ui.cancelButton.addEventListener('click', async () => {
  const running = jobs.filter(j => j.status === 'running' || j.status === 'queued');
  if (!running.length) return;
  const confirmed = await askConfirm({
    title: `Cancel ${running.length} active job${running.length === 1 ? '' : 's'}?`,
    message: 'Finished tracks stay on disk.',
    confirmLabel: 'Cancel jobs',
    cancelLabel: 'Keep downloading',
    danger: true
  });
  if (!confirmed) return;
  for (const job of running) {
    try { await api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: '{}' }); }
    catch (err) { toast(err.message, 'error'); }
  }
  await refresh();
});

ui.modalBody.addEventListener('click', async event => {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const trackId = btn.dataset.track;
  const job = jobs.find(j => j.id === openModalJobId);
  const track = job && job.tracks.find(t => t.id === trackId);
  if (!track) return;
  if (btn.dataset.action === 'open-file') {
    try { await api('/api/open', { method: 'POST', body: JSON.stringify({ path: track.file, reveal: true }) }); }
    catch (err) { toast(err.message, 'error'); }
  }
  if (btn.dataset.action === 'retry-track') {
    try {
      const result = await api(`/api/jobs/${job.id}/retry`, { method: 'POST', body: JSON.stringify({ trackId: track.id }) });
      toast(`Retrying ${result.retried} track${result.retried === 1 ? '' : 's'}.`);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }
  if (btn.dataset.action === 'edit-tags') {
    const row = btn.closest('.track-detail');
    row.querySelectorAll('[data-field]').forEach(el => el.hidden = true);
    row.querySelectorAll('[data-edit]').forEach(el => el.hidden = false);
    btn.hidden = true;
    row.querySelector('[data-action="save-tags"]').hidden = false;
    row.querySelector('[data-action="cancel-edit"]').hidden = false;
  }
  if (btn.dataset.action === 'cancel-edit') {
    const row = btn.closest('.track-detail');
    row.querySelectorAll('[data-field]').forEach(el => el.hidden = false);
    row.querySelectorAll('[data-edit]').forEach(el => el.hidden = true);
    btn.hidden = true;
    row.querySelector('[data-action="save-tags"]').hidden = true;
    row.querySelector('[data-action="edit-tags"]').hidden = false;
  }
  if (btn.dataset.action === 'save-tags') {
    const row = btn.closest('.track-detail');
    const titleInput = row.querySelector('[data-edit="title"]');
    const artistInput = row.querySelector('[data-edit="artist"]');
    try {
      await api('/api/tags/edit', {
        method: 'POST',
        body: JSON.stringify({
          file: track.file,
          tags: { title: titleInput.value, artist: artistInput.value }
        })
      });
      row.querySelector('[data-field="title"]').textContent = titleInput.value;
      row.querySelector('[data-field="artist"]').textContent = `${artistInput.value}, #${String(track.index).padStart(2, '0')}`;
      row.querySelectorAll('[data-field]').forEach(el => el.hidden = false);
      row.querySelectorAll('[data-edit]').forEach(el => el.hidden = true);
      btn.hidden = true;
      row.querySelector('[data-action="cancel-edit"]').hidden = true;
      row.querySelector('[data-action="edit-tags"]').hidden = false;
      toast('Tags saved.');
    } catch (err) { toast(err.message, 'error'); }
  }
});

// Toolbar
ui.librarySearch.addEventListener('input', () => { lastFilmstripSig = ''; renderLibrary(); });
ui.libraryFilter.addEventListener('change', () => { lastFilmstripSig = ''; renderLibrary(); });
ui.librarySort.addEventListener('change', () => { lastFilmstripSig = ''; renderLibrary(); });

ui.exportButton.addEventListener('click', exportHistory);
ui.clearCacheButton.addEventListener('click', async () => {
  try {
    const result = await api('/api/cache/clear', { method: 'POST', body: '{}' });
    toast(`Cleared ${result.removed} cached playlist${result.removed === 1 ? '' : 's'}.`);
  } catch (err) { toast(err.message, 'error'); }
});

// Cancel a job from the activity panel
function renderAudioFormatList(list) {
  ui.formatSelect.innerHTML = list
    .map(f => `<option value="${escapeAttr(f.key)}">${escapeHtml(f.label)}</option>`)
    .join('');
  if (status.format) ui.formatSelect.value = status.format;
  ui.formatSelect._syncMenu?.();
}

function renderVideoFormatList(list) {
  // "Best quality" and the generic source entry stay in the engine for jobs
  // made before the ladder existed. The picker only offers real heights.
  const options = list.filter(f => f.key !== 'best' && f.key !== 'source');
  ui.videoFormatSelect.innerHTML = options
    .map(f => `<option value="${escapeAttr(f.key)}">${escapeHtml(f.label)}</option>`)
    .join('');
  // 1080p is the sensible default; 4K stays one click away.
  if (ui.videoFormatSelect.querySelector('option[value="1080p"]')) ui.videoFormatSelect.value = '1080p';
  ui.videoFormatSelect._syncMenu?.();
}

async function loadFormats() {
  try {
    const data = await api('/api/formats');
    audioFormatList = data.formats;
    renderAudioFormatList(audioFormatList);
  } catch {}
}

async function loadVideoFormats() {
  try {
    const data = await api('/api/video-formats');
    videoFormatList = data.formats;
    renderVideoFormatList(videoFormatList);
  } catch {}
}

// Tracks become videos when the mode switch flips. Rewriting the two words
// in place keeps the list scroll position.
function updateSelectionNouns() {
  const noun = status.isVideo ? 'video' : 'track';
  ui.selectionSources.querySelectorAll('.source-meta').forEach(meta => {
    const count = Number(meta.dataset.count) || 0;
    const cached = meta.dataset.cached === '1' ? ' (cached)' : '';
    meta.textContent = meta.dataset.single === '1'
      ? `Single video${cached}`
      : `${count} ${noun}${count === 1 ? '' : 's'}${cached}`;
  });
  ui.selectionSources.querySelectorAll('.source-group').forEach(group => {
    updateGroupBadges(Number(group.dataset.source));
  });
}

function applyMode() {
  const isVideo = status.isVideo === true;
  ui.audioQualitySection.hidden = isVideo;
  ui.videoQualitySection.hidden = !isVideo;
  ui.modeAudio.classList.toggle('active', !isVideo);
  ui.modeVideo.classList.toggle('active', isVideo);
  ui.modeAudio.setAttribute('aria-pressed', String(!isVideo));
  ui.modeVideo.setAttribute('aria-pressed', String(isVideo));
  updateSelectionNouns();
  updateDownloadButton();
}

function setMode(isVideo) {
  status.isVideo = isVideo;
  applyMode();
  // Save preference in background; don't block the UI toggle
  postSettings({ isVideo }).catch(() => {});
}

ui.modeAudio.addEventListener('click', () => setMode(false));
ui.modeVideo.addEventListener('click', () => setMode(true));

/* ---- Custom select menus ---- */
const selectMenuState = { close: null };

function initSelectMenus() {
  document.querySelectorAll('select').forEach(select => {
    if (select.dataset.enhanced === 'true') return;
    select.dataset.enhanced = 'true';

    const menuId = `${select.id}Menu`;
    const triggerId = `${select.id}Trigger`;

    const wrap = document.createElement('div');
    wrap.className = 'select';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.id = triggerId;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', menuId);

    const labelEl = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
    const baseName = labelEl
      ? labelEl.textContent.trim()
      : (select.getAttribute('aria-label') || select.id || 'Choose');
    if (labelEl) {
      if (!labelEl.id) labelEl.id = `${select.id}Label`;
      labelEl.setAttribute('for', triggerId);
    }
    const setTriggerName = text => {
      trigger.setAttribute('aria-label', text ? `${baseName}: ${text}` : baseName);
    };

    const valueEl = document.createElement('span');
    valueEl.className = 'select-value';

    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'select-chevron');
    chevron.setAttribute('viewBox', '0 0 12 12');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<path fill="currentColor" d="M6 9.3 3.7 7a.75.75 0 0 1 1.06-1.06L6 7.19l1.24-1.24A.75.75 0 0 1 8.3 7L6 9.31Z"/>';

    trigger.append(valueEl, chevron);

    const menu = document.createElement('div');
    menu.className = 'select-menu';
    menu.id = menuId;
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    menu.tabIndex = -1;
    if (labelEl) menu.setAttribute('aria-labelledby', labelEl.id);

    select.classList.add('select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(wrap);
    wrap.append(trigger, menu);

    let activeIndex = -1;

    const options = () => Array.from(select.options);

    function setActive(index) {
      const items = Array.from(menu.children);
      if (!items.length) return;
      items.forEach(el => el.classList.remove('active'));
      activeIndex = index;
      const el = items[index];
      if (!el) return;
      el.classList.add('active');
      trigger.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView({ block: 'nearest' });
    }

    function moveActive(delta) {
      const items = Array.from(menu.children);
      if (!items.length) return;
      let index = activeIndex;
      for (let n = 0; n < items.length; n++) {
        index = (index + delta + items.length) % items.length;
        if (items[index].getAttribute('aria-disabled') !== 'true') {
          setActive(index);
          return;
        }
      }
    }

    function render() {
      menu.innerHTML = '';
      options().forEach((opt, index) => {
        const item = document.createElement('div');
        item.className = 'select-option';
        item.id = `${select.id}Opt${index}`;
        item.setAttribute('role', 'option');
        item.dataset.value = opt.value;
        item.setAttribute('aria-selected', String(opt.value === select.value));
        if (opt.disabled) item.setAttribute('aria-disabled', 'true');

        const label = document.createElement('span');
        label.className = 'option-label';
        label.textContent = opt.textContent;

        const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        check.setAttribute('class', 'check');
        check.setAttribute('viewBox', '0 0 13 13');
        check.setAttribute('aria-hidden', 'true');
        check.innerHTML = '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m2.5 6.8 2.6 2.6 5.4-5.6"/>';

        item.append(label, check);
        item.addEventListener('click', () => choose(opt.value));
        menu.append(item);
      });

      const selected = select.options[select.selectedIndex];
      const text = selected ? selected.textContent.trim() : '';
      valueEl.textContent = selected ? selected.textContent : 'Choose…';
      valueEl.title = text;
      setTriggerName(text);
      trigger.disabled = select.disabled;
    }

    function choose(value) {
      const opt = options().find(o => o.value === value);
      if (!opt || opt.disabled) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      render();
      close();
      trigger.focus();
    }

    function position() {
      menu.classList.remove('up', 'right');
      let rect = menu.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 10 && trigger.getBoundingClientRect().top > rect.height + 10) {
        menu.classList.add('up');
        rect = menu.getBoundingClientRect();
      }
      if (rect.right > window.innerWidth - 12) menu.classList.add('right');
    }

    function open() {
      if (select.disabled) return;
      if (selectMenuState.close) selectMenuState.close();
      render();
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      position();
      const selectedIndex = options().findIndex(o => o.value === select.value && !o.disabled);
      if (selectedIndex >= 0) setActive(selectedIndex);
      selectMenuState.close = close;
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', close);
      window.addEventListener('scroll', onWindowScroll, true);
    }

    function close() {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      menu.querySelectorAll('.active').forEach(el => el.classList.remove('active'));
      activeIndex = -1;
      if (selectMenuState.close === close) selectMenuState.close = null;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onWindowScroll, true);
    }

    function onPointerDown(event) {
      if (!wrap.contains(event.target)) close();
    }

    function onWindowScroll(event) {
      if (menu.contains(event.target)) return;
      close();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); return; }
      if (event.key === 'Tab') { close(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); return; }
      if (event.key === 'Home') { event.preventDefault(); setActive(0); return; }
      if (event.key === 'End') { event.preventDefault(); setActive(menu.children.length - 1); return; }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const el = menu.children[activeIndex];
        if (el && el.getAttribute('aria-disabled') !== 'true') choose(el.dataset.value);
        return;
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const ch = event.key.toLowerCase();
        const items = Array.from(menu.children);
        const start = activeIndex < 0 ? 0 : activeIndex + 1;
        for (let n = 0; n < items.length; n++) {
          const index = (start + n) % items.length;
          const el = items[index];
          if (el.getAttribute('aria-disabled') === 'true') continue;
          if (el.textContent.trim().toLowerCase().startsWith(ch)) { event.preventDefault(); setActive(index); break; }
        }
      }
    }

    trigger.addEventListener('click', () => {
      if (menu.hidden) open(); else close();
    });

    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (menu.hidden) open();
      }
    });

    const observer = new MutationObserver(render);
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'label'] });

    select._syncMenu = render;
    render();
  });
}

/* ---- Library actions menu ---- */
function initLibraryMenu() {
  const button = ui.libraryMenuButton;
  const menu = ui.libraryMenu;
  if (!button || !menu) return;
  const items = () => Array.from(menu.querySelectorAll('[role="menuitem"]'));

  function close(focusButton = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey, true);
    if (focusButton) button.focus();
  }

  function open() {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey, true);
    items()[0]?.focus();
  }

  function onDocPointer(event) {
    if (menu.contains(event.target) || button.contains(event.target)) return;
    close();
  }

  function onDocKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { close(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const list = items();
    const index = list.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? (index + 1) % list.length
      : (index - 1 + list.length) % list.length;
    list[next].focus();
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close(true)));
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && menu.hidden) { event.preventDefault(); open(); }
  });
  menu.addEventListener('click', event => {
    if (event.target.closest('[role="menuitem"]')) close();
  });
}

initTheme();
initSelectMenus();
initLibraryMenu();
buildWave();
loadFormats();
loadVideoFormats();
refresh().then(applyMode);
connectEvents();
setInterval(() => { refresh(); }, 3000);
// Re-check the moment the tab regains focus (e.g. after deleting folders in Explorer).
window.addEventListener('focus', () => { refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
