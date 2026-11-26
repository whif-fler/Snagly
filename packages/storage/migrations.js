'use strict';

/** Ordered, idempotent schema migrations. Never edit an applied migration. */
const MIGRATIONS = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_url TEXT NOT NULL,
        playlist_key TEXT NOT NULL,
        playlist_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        thumb TEXT,
        folder_name TEXT NOT NULL,
        status TEXT NOT NULL,
        single INTEGER NOT NULL DEFAULT 0,
        is_video INTEGER NOT NULL DEFAULT 0,
        format TEXT NOT NULL,
        collection TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT,
        expires_at TEXT,
        error TEXT,
        total_bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_jobs_user_created ON jobs(user_id, created_at DESC);
      CREATE INDEX idx_jobs_expires ON jobs(expires_at);

      CREATE TABLE tracks (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        video_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL DEFAULT '',
        album TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        phase TEXT,
        progress REAL NOT NULL DEFAULT 0,
        speed TEXT NOT NULL DEFAULT '',
        eta INTEGER,
        size INTEGER NOT NULL DEFAULT 0,
        filename TEXT,
        error TEXT,
        warning TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(job_id, idx)
      );
      CREATE INDEX idx_tracks_job_idx ON tracks(job_id, idx);
      CREATE INDEX idx_tracks_user_status ON tracks(user_id, status);

      CREATE TABLE user_settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `
  }
];

module.exports = { MIGRATIONS };
