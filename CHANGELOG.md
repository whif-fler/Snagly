# Changelog

All notable changes to Snagly are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Library selection mode: pick individual downloads, or all visible ones, and
  remove them together. Local mode also offers a bulk "Delete files" action; cloud
  mode removes only the server copies.

### Removed

- YouTube cookie sign-in from local mode. Both modes are now guest-only: Snagly no
  longer reads browser cookies or `cookies.txt`, and it has no cookie, password or
  OAuth controls. Age-restricted, private, members-only and bot-checked videos may
  fail.

### Changed

- Removed the `localBrowserCookies` capability and the local `useCookies` /
  `cookieSource` status fields.

## [2.0.0] — 2026-11-27

### Added

- Self-hosted cloud application in `apps/server` with anonymous sessions, CSRF
  protection, per-user isolation, SQLite persistence and an in-process scheduler.
- npm workspace layout with shared `core`, `config`, `contracts`, `platform`,
  `storage`, `media`, `download-engine` and `library` packages.
- File System Access API folder saving in Chromium, plus standard individual and
  streaming ZIP downloads for every browser.
- HMAC-signed, expiring delivery URLs scoped to one user, job and track.
- Cloud capabilities endpoint and UI branches that hide local-only cookie,
  browse, open and path-based tag controls.
- Multi-stage Docker image, non-root runtime, read-only root filesystem, dropped
  capabilities, health check, graceful shutdown and Compose resource limits.
- Optional Cloudflare Tunnel profile.
- Backup/restore scripts for the persistent data volume.
- CI matrix across Linux, Windows and macOS with Node 22 and 24, plus a Docker
  build job.
- Dependabot configuration for npm, GitHub Actions and Docker.
- ESLint, Prettier, TypeScript contract checking and a syntax check script.
- Architecture, security, deployment, API, desktop-integration and ADR docs.
- Cloud test suite covering migrations, sessions, cross-user isolation, security
  regressions, cancellation, timeouts, cleanup, ZIP structure and mocked
  end-to-end downloads.

### Changed

- `public/` moved to `apps/web/public/`; the local server and start script point
  at the new location.
- `lib/util.js` now re-exports the shared core so local and cloud validation
  cannot drift.
- The local server keeps using `data/state.json`; no existing local data is
  migrated or deleted.
- Root `package.json` is an npm workspace and requires Node 22.13+.

### Security

- Host/Origin allow-lists, strict JSON bodies, prototype-pollution filtering,
  request size limits and rate limits.
- Strict CSP and security headers.
- Shell-free subprocess execution with timeout, output caps and tree kill.
- Thumbnail proxy restricted to YouTube image hosts without redirects.
- Filename/path sanitisation and containment checks.
- No server paths or cross-user data in API responses, SSE or delivery.
- Origin checks compare the full authority, including port, and unsafe requests
  require a JSON content type.
- In-memory preview and on-disk thumbnail caches are bounded, with oldest-first
  eviction, so repeated requests cannot exhaust memory or disk.
- Browser cookie extraction and arbitrary filesystem actions disabled in cloud
  mode.

### Known limitations

- Folder saving is Chromium-only; other browsers use standard/ZIP downloads.
- No account/password authentication; use Cloudflare Access for a public instance.
- Single-instance SQLite and scheduler; horizontal scaling is unsupported.
- Migrations are forward-only; back up before upgrading.
- Docker and Oracle deployment were not executed in the development environment;
  CI builds the image, but operators must verify their host.

## [1.0.0]

- Original local Windows app: YouTube playlists to tagged audio or video, live
  progress, filmstrip library, optional browser sign-in, JSON state.
