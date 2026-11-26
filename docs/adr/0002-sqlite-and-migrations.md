# ADR 0002: SQLite with forward-only migrations

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Cloud state needs durable, transactional storage for users, sessions, jobs and
tracks. The target is a single small VM. Native SQLite npm modules require build
toolchains and complicate multi-arch images.

## Decision

Use Node's built-in `node:sqlite` (`DatabaseSync`) with:

- WAL mode and foreign keys;
- ordered migrations recorded in `_migrations`;
- each migration applied inside a transaction;
- repositories that always scope user-facing queries by `user_id`.

Node 22.13+ is required because `node:sqlite` is no longer behind a flag there.

## Consequences

- No native build step; the image stays small and multi-arch.
- One database file plus media directories is easy to back up when stopped.
- Migrations are forward-only. A rollback across a schema change requires
  restoring a pre-upgrade backup.
- SQLite is single-writer. Concurrency limits and `BEGIN IMMEDIATE` claims keep
  contention small, but multiple app replicas are unsupported.
- `node:sqlite` ties the project to a modern Node release.
