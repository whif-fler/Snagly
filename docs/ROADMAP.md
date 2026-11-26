# Snagly 2.0 Roadmap

Status: implementation complete; host deployment verification pending  
Branch: `feat/snagly-2-web`  
Baseline: `f84c442` — 22/22 tests passing, CI green.

## Goal

Ship **Snagly Web** as a secure, self-hosted, multi-user browser application on
Oracle Cloud + Docker Compose + Cloudflare, while keeping the existing vanilla
UI/design and preserving the local Windows application. Build the shared core so
a future Electron shell can reuse the same domain, storage and delivery
interfaces.

## Non-negotiable constraints

- Modular monolith, npm workspaces, no React/Next.js/microservices/Kubernetes.
- Single-origin deployment. Cloudflare Tunnel terminates public TLS.
- SQLite for cloud persistence, with versioned migrations.
- Shared core must not import HTTP, Electron, browser globals or Oracle code.
- Cloud mode disables browser-cookie extraction, native folder pickers, arbitrary
  server paths and cross-user access.
- Existing local Windows app must keep working.
- No destructive migration of the existing `data/` state.
- No production deployment or credential changes without explicit approval.

## Phase plan

### Phase 0 — Baseline and guardrails

- [x] Inspect repository, record baseline tests and git state.
- [x] Create branch `feat/snagly-2-web`.
- [x] Write this roadmap.
- [x] Capture architecture/security decisions as ADRs.

### Phase 1 — Workspace and shared contracts

- [x] Convert root package to npm workspaces.
- [x] Add `packages/config`, `packages/contracts`, `packages/core`,
      `packages/platform`, `packages/storage`, `packages/download-engine`,
      `packages/media`, `packages/library`.
- [x] Move shared validation/naming contracts behind explicit modules.
- [x] Keep legacy `server.js`/`engine.js` imports working.
- [x] Add lint/format/type-check scripts and lockfile.

### Phase 2 — Storage and sessions

- [x] SQLite schema + migration runner (`node:sqlite`, WAL, foreign keys).
- [x] Anonymous secure sessions with hashed tokens, expiry and CSRF.
- [x] Repositories for users, sessions, jobs, tracks and settings.
- [x] Per-user isolated storage roots and path guards.
- [x] Migration and repository tests.

### Phase 3 — Download core

- [x] Cross-platform executable discovery and configurable binary paths.
- [x] Shell-free subprocess runner with timeout and tree cancellation.
- [x] Extraction/probe adapter with strict YouTube URL allow-list.
- [x] Queue scheduler with global and per-user concurrency.
- [x] Media conversion/tagging and file naming shared with legacy rules.
- [x] Recovery of interrupted jobs; cleanup of expired data.
- [x] Mocked deterministic engine for CI and real-engine smoke test split.

### Phase 4 — Cloud API

- [x] Session bootstrap and capability config endpoints.
- [x] Per-user jobs, tracks, preview, retry, cancel, history, library.
- [x] SSE with per-user filtering, heartbeat, resume-by-refresh.
- [x] Expiring authorized file and ZIP delivery.
- [x] Strict Host/Origin/CSRF/body/rate limits; security headers.
- [x] No `open`, `browse`, cookie, or arbitrary filesystem endpoints in cloud.
- [x] Cross-user isolation and security regression tests.

### Phase 5 — Browser UI

- [x] Preserve markup, typography, colours, icons and interaction patterns.
- [x] Capability detection: hide local save/browse/cookie controls.
- [x] Cloud save flow: File System Access API + IndexedDB handles.
- [x] Standard fallback: individual files and streaming ZIP.
- [x] Distinguish server completion from local save completion.
- [x] Reconnection, error, empty, loading and permission states.
- [x] Responsive/accessibility pass (existing patterns preserved; cloud branches
      reuse them).

### Phase 6 — Operations

- [x] Multi-stage Dockerfile, non-root user, healthcheck, graceful shutdown.
- [x] Docker Compose with volumes, limits, log rotation and restart policy.
- [x] `.env.example`, backup/restore scripts, Cloudflare Tunnel docs.
- [x] CI: Linux/Windows/macOS matrix, tests, type/lint checks, Docker build.
- [x] Dependency update configuration and semantic versioning.

### Phase 7 — Documentation and final audit

- [x] README, ARCHITECTURE, SECURITY, CONTRIBUTING, CHANGELOG, PRIVACY.
- [x] docs/DEPLOYMENT.md, docs/DESKTOP-INTEGRATION.md, docs/API.md, ADRs.
- [x] Repository-wide security and performance review.
- [x] Final verification matrix and honest limitations.
- [x] Exact Oracle commands and rollback instructions.

## Verification matrix

| Gate                                | Status | Evidence                             |
| ----------------------------------- | ------ | ------------------------------------ |
| Legacy local tests still pass       | ✅     | `npm test` includes `test/`          |
| Cloud migrations idempotent         | ✅     | `tests/storage.test.js`              |
| Cross-user jobs/files/ZIPs isolated | ✅     | `tests/api.test.js`, scheduler tests |
| CSRF/Host/Origin/body limits        | ✅     | `tests/api.test.js`                  |
| SSRF/thumbnail allow-list           | ✅     | `tests/api.test.js`                  |
| Signed link tampering/expiry        | ✅     | `tests/api.test.js`                  |
| Cancellation and timeout            | ✅     | `tests/scheduler.test.js`            |
| Cleanup skips active jobs           | ✅     | `tests/scheduler.test.js`            |
| Mocked end-to-end + ZIP             | ✅     | `tests/api.test.js`                  |
| Lint/typecheck/format/syntax        | ✅     | scripts run locally                  |
| Docker image builds                 | ⚠️     | CI job added; no local Docker CLI    |
| Oracle + Cloudflare deployment      | ⚠️     | documented; not executed here        |
| Real yt-dlp/FFmpeg download         | ⚠️     | manual smoke test required           |

## Acceptance gates

The application is not called production-ready until:

1. Linux start/build and migration tests pass in CI. **CI configured; awaiting a
   real run on GitHub.**
2. Two independent sessions cannot read each other's jobs, events, files or ZIPs.
   **Covered by tests; SSE isolation has a dedicated test.**
3. Folder-save works in a Chromium browser, or is clearly reported unsupported.
   **Implemented; manual browser check required.**
4. Standard file and ZIP downloads work under the same session cookie. **Covered
   by tests.**
5. Cancellation kills the subprocess within a bounded time. **Covered by tests
   with the mock adapter; real yt-dlp smoke test required.**
6. Cleanup never removes an active or in-flight delivery file. **Active jobs are
   skipped; delivery references are short-lived. Manual load check recommended.**
7. Docker image builds and runs as non-root with a persistent volume. **CI job
   added; no local Docker CLI.**
8. No high/critical dependency or application security finding remains open.
   **`npm audit` clean at install time; re-run in CI and before release.**

## Known risks / decisions

- `yt-dlp` is pinned into the image and verified by SHA-256.
- SQLite driver: Node's built-in `node:sqlite`; requires Node ≥ 22.13.
- Anonymous sessions keep sign-up friction at zero; Cloudflare Access can provide
  authentication. Accounts can be added later without changing ownership.
- File System Access API is Chromium-only; Safari/Firefox use individual/ZIP
  downloads.
- Existing local `data/` is not migrated into cloud storage; local data stays put.
- Cloud mode retains media for the retention period; the operator can read it.
- Single app instance only; no horizontal scaling.
- Migrations are forward-only; back up before upgrading.
