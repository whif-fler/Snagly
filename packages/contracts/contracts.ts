/** Versioned API contract shared by the cloud server, web client and tests. */

export type Mode = 'cloud' | 'local';

export type JobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled';
export type TrackStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'missing';

export interface Capabilities {
  mode: Mode;
  localFolderPicker: boolean;
  serverTagEditing: boolean;
  fileSystemAccess: boolean;
  standardDownloads: boolean;
  zipDownload: boolean;
  arbitraryServerPaths: boolean;
}

export interface PublicTrack {
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
  filename: string | null;
  error: string | null;
  warning: string | null;
  completedAt: string | null;
  downloadUrl: string | null;
}

export interface PublicJob {
  id: string;
  url: string;
  sourceUrl: string;
  playlistId: string;
  title: string;
  thumb: string | null;
  folderName: string;
  albumTag: string;
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
  archiveUrl: string | null;
  tracks: PublicTrack[];
}

export interface SessionResponse {
  apiVersion: string;
  user: { id: string };
  csrfToken: string;
  capabilities: Capabilities;
  retentionHours: number;
  limits: {
    globalConcurrency: number;
    perUserConcurrency: number;
    maxPlaylistEntries: number;
    maxLinksPerRequest: number;
    maxFileMb: number;
  };
}

export interface PreviewEntry {
  index: number;
  videoId: string;
  title: string;
  artist: string;
  duration: number | null;
}

export interface PreviewSource {
  url: string;
  title: string;
  thumb: string | null;
  single: boolean;
  entries: PreviewEntry[];
  formats: Array<{ key: string; label: string; height: number }> | null;
}

export interface PreviewResponse {
  sources: PreviewSource[];
  errors: Array<{ url: string; error: string }>;
}

export interface JobsResponse {
  jobs: PublicJob[];
  status: StatusResponse;
}

export interface StatusResponse {
  mode: Mode;
  apiVersion: string;
  paused: boolean;
  workers: number;
  active: number;
  queued: number;
  retentionHours: number;
  capabilities: Capabilities;
  tools: { yt: boolean; ffmpeg: boolean };
}

export interface CreateJobsRequest {
  items?: Array<{ url: string; selected?: number[] }>;
  urls?: string[];
  format?: string;
  isVideo?: boolean;
  collection?: string;
  allowDuplicate?: boolean;
}

export interface CreateJobsResponse {
  created: PublicJob[];
  errors: Array<{ url: string; error: string; duplicate?: boolean }>;
}

export interface ApiError {
  error: string;
  code?: string;
  retryAfter?: number;
}
