export type JobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled';
export type TrackStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped' | 'missing';
export type MediaKind = 'audio' | 'video';

export interface Track {
  id: string;
  index: number;
  videoId: string;
  title: string;
  artist: string;
  album: string;
  status: TrackStatus;
  phase: string | null;
  progress: number;
  speed: string;
  eta: number | null;
  size: number;
  error: string | null;
  warning: string | null;
  completedAt: string | null;
}

export interface Job {
  id: string;
  userId?: string;
  sourceUrl: string;
  playlistId: string;
  title: string;
  thumb: string | null;
  folderName: string;
  status: JobStatus;
  single: boolean;
  isVideo: boolean;
  format: string;
  trackCount: number;
  done: number;
  failed: number;
  cancelled: number;
  missing: number;
  running: number;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  tracks: Track[];
}

export function parseYouTubeUrl(value: unknown): URL | null;
export function isYouTubeUrl(value: unknown): boolean;
export function videoIdFromUrl(value: unknown): string;
export function playlistIdFromUrl(value: unknown): string;
export function isSingleVideoUrl(value: unknown): boolean;
export function canonicalWatchUrl(videoId: string): string;
export function parseThumbnailUrl(value: unknown): URL | null;
export function isPathInside(parent: string, child: string): boolean;
export function escapeRegExp(value: unknown): string;
export function safeJsonParse<T>(text: string, fallback?: T): T | null;
export function sanitizeTags(tags: unknown): Record<string, string> | null;
export function isMediaFile(file: unknown): boolean;
export function sanitizeFolder(name: unknown, fallback?: string, maxLength?: number): string;
export function sanitizeFilename(name: unknown, fallback?: string, maxLength?: number): string;
export function parseSelection(selected: unknown, max?: number): Set<number> | null;
