'use strict';

// Presets are intentionally server-owned. A request may only choose a known
// key; it can never inject arbitrary yt-dlp or FFmpeg arguments.
const AUDIO_FORMATS = Object.freeze({
  mp3: Object.freeze({
    key: 'mp3',
    ext: '.mp3',
    label: 'MP3 320 kbps',
    args: Object.freeze(['-x', '--audio-format', 'mp3', '--audio-quality', '320K'])
  }),
  mp3v0: Object.freeze({
    key: 'mp3v0',
    ext: '.mp3',
    label: 'MP3 V0 (VBR)',
    args: Object.freeze(['-x', '--audio-format', 'mp3', '--audio-quality', 'V0'])
  }),
  flac: Object.freeze({
    key: 'flac',
    ext: '.flac',
    label: 'FLAC (lossless)',
    args: Object.freeze(['-x', '--audio-format', 'flac'])
  }),
  opus: Object.freeze({
    key: 'opus',
    ext: '.opus',
    label: 'Opus',
    args: Object.freeze(['-x', '--audio-format', 'opus', '--audio-quality', '0'])
  }),
  m4a: Object.freeze({
    key: 'm4a',
    ext: '.m4a',
    label: 'M4A / AAC',
    args: Object.freeze(['-x', '--audio-format', 'm4a', '--audio-quality', '0'])
  }),
  best: Object.freeze({
    key: 'best',
    ext: '',
    label: 'Best available (original)',
    args: Object.freeze(['-f', 'bestaudio/best'])
  })
});

function videoArgs(height) {
  return Object.freeze([
    '-f',
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/` +
      `bestvideo[height<=${height}]+bestaudio/` +
      `best[height<=${height}][ext=mp4]/best[height<=${height}]`
  ]);
}

const VIDEO_FORMATS = Object.freeze({
  '2160p': Object.freeze({
    key: '2160p',
    label: '4K MP4 (2160p)',
    ext: '.mp4',
    merge: true,
    args: videoArgs(2160)
  }),
  '1440p': Object.freeze({
    key: '1440p',
    label: '1440p MP4',
    ext: '.mp4',
    merge: true,
    args: videoArgs(1440)
  }),
  '1080p': Object.freeze({
    key: '1080p',
    label: '1080p MP4',
    ext: '.mp4',
    merge: true,
    args: videoArgs(1080)
  }),
  '720p': Object.freeze({ key: '720p', label: '720p MP4', ext: '.mp4', merge: true, args: videoArgs(720) }),
  '480p': Object.freeze({ key: '480p', label: '480p MP4', ext: '.mp4', merge: true, args: videoArgs(480) }),
  '360p': Object.freeze({ key: '360p', label: '360p MP4', ext: '.mp4', merge: true, args: videoArgs(360) }),
  source: Object.freeze({
    key: 'source',
    label: 'Source quality',
    ext: '.mp4',
    merge: true,
    args: Object.freeze(['-f', 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best'])
  }),
  best: Object.freeze({
    key: 'best',
    label: 'Best quality',
    ext: '.mp4',
    merge: true,
    args: Object.freeze(['-f', 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best'])
  })
});

function getAudioFormat(key) {
  return AUDIO_FORMATS[key] || AUDIO_FORMATS.mp3;
}

function getVideoFormat(key) {
  return VIDEO_FORMATS[key] || VIDEO_FORMATS['1080p'];
}

function isKnownAudioFormat(key) {
  return Object.hasOwn(AUDIO_FORMATS, String(key));
}

function isKnownVideoFormat(key) {
  return Object.hasOwn(VIDEO_FORMATS, String(key));
}

function formatOptions(kind) {
  const source = kind === 'video' ? VIDEO_FORMATS : AUDIO_FORMATS;
  return Object.values(source).map(({ key, label, ext }) => ({ key, label, ext: ext.replace(/^\./, '') }));
}

module.exports = {
  AUDIO_FORMATS,
  VIDEO_FORMATS,
  getAudioFormat,
  getVideoFormat,
  isKnownAudioFormat,
  isKnownVideoFormat,
  formatOptions
};
