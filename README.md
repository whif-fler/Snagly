<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/assets/logo-dark.svg">
    <img src="apps/web/public/assets/logo-light.svg" alt="Snagly" width="280">
  </picture>
</p>

<p align="center">
  <strong>YouTube playlists → a tidy, tagged music library.</strong><br>
  Run it locally on Windows, or self-host it for a small group.<br>
  No account; uses an anonymous session cookie in cloud mode.
</p>

<p align="center">
  <img alt="Node.js 22.13+" src="https://img.shields.io/badge/Node.js-22.13%2B-5FA04E?logo=nodedotjs&logoColor=white">
  <img alt="Local and self-hosted" src="https://img.shields.io/badge/modes-local%20%7C%20self--hosted-5E5CE6">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-1D1D1F">
  <img alt="SQLite" src="https://img.shields.io/badge/storage-SQLite-003B57?logo=sqlite&logoColor=white">
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Snagly interface" width="880">
</p>

Snagly turns YouTube playlist links into properly named, tagged audio files — or
downloads them as MP4 video up to 4K. It keeps the original vanilla HTML/CSS/JS
interface and now ships in two forms:

- **Local mode** (`node server.js`): the original single-user Windows app. It
  listens on `127.0.0.1`, writes into a folder you choose, and downloads public
  videos without a YouTube account.
- **Cloud mode** (`apps/server`): a secure, self-hosted, multi-user web app. It
  runs in Docker behind Cloudflare Tunnel, stores jobs in SQLite, isolates every
  user's jobs and files, and lets each person save finished files to their own
  device.

Both modes share validation, naming, storage and download logic from `packages/`.
Both are guest-only: neither reads browser cookies or a `cookies.txt` export. The
cloud app also never accepts arbitrary server paths and never exposes one user's
files to another.

## Which mode do I want?

| If you want to…                       | Use                   | Start here                                                                                         |
| ------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| Use an instance someone else runs     | Hosted cloud          | Open the URL you were given. Nothing to install, and files are deleted after the retention window. |
| Run your own server for a small group | Self-host with Docker | [Run the cloud app](#run-the-cloud-app): Docker Compose behind Cloudflare Tunnel.                  |
| Download on your own Windows PC       | Local mode            | [Run locally](#run-locally): `node server.js`, files go straight to a folder you choose.           |

## Features

**Downloading**

- Playlists and single videos, several links at a time
- Audio: MP3 320 kbps, MP3 V0 (VBR), FLAC, Opus, M4A/AAC, or best available
- Video: MP4 at 360p, 480p, 720p, 1080p, 1440p or 2160p (4K), with quality
  ceilings so a 1080p source still downloads cleanly in a 4K batch
- Pick exactly which tracks to download — checkboxes, a range like `1-5, 8, 12`,
  per-playlist All/None, and a track filter
- Parallel downloads with global and per-user limits
- Pause, cancel, retry only failed tracks, resume interrupted work after restart
- Automatic cleanup after a configurable retention period

**Library**

- Every playlist becomes a folder named after the playlist title
- Tracks are numbered `01 - Title.mp3`; single videos keep `Title [id]`
- Cover art, title, artist and album embedded into each file
- Filmstrip library with search, status filter and sorting
- Retry failed tracks, remove jobs, edit tags
- Export download history as CSV

**Delivery**

- **File System Access API** (Chromium): choose a folder once, then save finished
  files directly from the browser with a progress-aware fallback
- **Standard downloads** (all browsers): individual signed file URLs and a
  streaming ZIP of a whole job
- **Electron-ready interface**: the same signed URLs and capability contract can
  back a future desktop shell (see `docs/DESKTOP-INTEGRATION.md`)

**Operations**

- Single-origin deployment behind Cloudflare Tunnel
- SQLite with forward-only, versioned migrations
- Multi-stage Docker image, non-root user, read-only root filesystem, dropped
  capabilities, persistent volume, health check and graceful shutdown
- Structured JSON logs with request/error context
- Backup and restore scripts
- Unit, API, isolation, security-regression, cancellation, cleanup and mocked
  end-to-end tests

## Requirements

| Requirement | Local mode              | Cloud mode                                       |
| ----------- | ----------------------- | ------------------------------------------------ |
| Node.js     | 22.13+                  | 22.13+ (the container pins Node 24)              |
| OS          | Windows 10/11           | Linux (Docker Compose)                           |
| yt-dlp      | winget install          | pinned into the image                            |
| FFmpeg      | winget install          | installed into the image                         |
| Docker      | —                       | Docker Engine + Compose v2                       |
| Browser     | Chrome, Edge or Firefox | Any modern browser; folder saving needs Chromium |

Install the local tools on Windows:

```powershell
winget install --id yt-dlp.yt-dlp -e
winget install --id yt-dlp.FFmpeg -e
```

## Run locally

Double-click `start.bat`, or run:

```powershell
npm install
node server.js
```

Open <http://localhost:4173>. The local app uses `data/state.json` and the folder
you choose. It does not use SQLite or sessions.

## Run the cloud app

```bash
cp .env.example .env
# Set SNAGLY_PUBLIC_ORIGIN, SNAGLY_ALLOWED_HOSTS and a generated secret.
openssl rand -base64 48

docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:4174/healthz
```

The app binds only to loopback. Put Cloudflare Tunnel in front of it:

```bash
# Add CLOUDFLARE_TUNNEL_TOKEN to .env, then:
docker compose --profile tunnel up -d
```

Full Oracle Cloud, DNS, backup, restore and rollback instructions are in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

For local development without Docker:

```bash
npm install
npm run dev:web
# http://127.0.0.1:4174
```

Set `SNAGLY_MEDIA_ENGINE=mock` for deterministic downloads without yt-dlp or
FFmpeg. This is the engine used by the automated tests.

## Using Snagly

1. Paste one or more playlist or video links, one per line.
2. Choose **Audio** or **Video**, then pick a quality.
3. _Local mode:_ set **Save to**, or change it later in **Settings → Storage**.
   _Cloud mode:_ choose a save folder once, or use the per-job ZIP/individual downloads.
4. Optionally open **Choose tracks** to preview the playlist and select a subset.
5. Press **Download**.
6. In cloud mode, finished files remain on the server for the retention period
   (24 hours by default). Save them to your device before they expire.

## Configuration

All cloud settings come from environment variables. See
[`.env.example`](.env.example) for the complete list and defaults.

| Variable                                   | Purpose                                                 |
| ------------------------------------------ | ------------------------------------------------------- |
| `SNAGLY_PUBLIC_ORIGIN`                     | Public HTTPS origin, used for cookies and Origin checks |
| `SNAGLY_ALLOWED_HOSTS`                     | Comma-separated accepted Host values                    |
| `SNAGLY_DOWNLOAD_SECRET`                   | HMAC key for expiring file/ZIP links                    |
| `SNAGLY_RETENTION_HOURS`                   | How long finished jobs and files are kept               |
| `SNAGLY_GLOBAL_CONCURRENCY`                | Total simultaneous downloads                            |
| `SNAGLY_USER_CONCURRENCY`                  | Simultaneous downloads per user                         |
| `SNAGLY_MAX_PLAYLIST_ENTRIES`              | Playlist preview cap                                    |
| `SNAGLY_MAX_FILE_MB` / `SNAGLY_MAX_JOB_MB` | File and archive size caps                              |
| `SNAGLY_MEDIA_ENGINE`                      | `real` (default) or `mock` for tests                    |
| `SNAGLY_TRUST_PROXY`                       | Trust `CF-Connecting-IP` / `X-Forwarded-For`            |
| `SNAGLY_SECURE_COOKIES`                    | Emit `Secure` cookies and HSTS                          |

## Architecture

```
Browser ──HTTPS/SSE──► apps/server ──► packages/library
                             │              │
                             │              ├── packages/download-engine
                             │              ├── packages/media
                             │              └── packages/storage ──► SQLite
                             │
                             └── packages/platform (process, signing, logs)

Local mode: server.js ──► engine.js ──► yt-dlp / FFmpeg
```

- `apps/server` — HTTP routing, sessions, CSRF, SSE, signed delivery, static UI.
- `apps/web/public` — unchanged vanilla interface, with cloud capability branches.
- `packages/core` — URL/thumbnail validation, sanitisation, format presets.
- `packages/config` — environment parsing and limits.
- `packages/contracts` — versioned API types and capability flags.
- `packages/storage` — SQLite migrations, repositories, per-user files, ZIP writer.
- `packages/download-engine` — yt-dlp/mock adapters, queue scheduler, recovery.
- `packages/media` — thumbnail proxy/cache and FFmpeg metadata rewriting.
- `packages/platform` — executable discovery, shell-free process runner, HMAC, logs.
- `server.js` / `engine.js` — the preserved local Windows application.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for data flow, schema and
isolation details, and [`docs/API.md`](docs/API.md) for the versioned HTTP API.

## Project layout

| Path                             | Purpose                                                                   |
| -------------------------------- | ------------------------------------------------------------------------- |
| `apps/server/`                   | Cloud entrypoint and HTTP layer                                           |
| `apps/web/public/`               | Shared static UI (local and cloud)                                        |
| `packages/`                      | Shared core, config, contracts, storage, media, engine, library, platform |
| `server.js`, `engine.js`, `lib/` | Original local application, preserved                                     |
| `tests/`                         | Cloud unit, API, isolation, security and end-to-end tests                 |
| `test/`                          | Original local-mode tests                                                 |
| `deployment/`                    | Reserved for host-specific deployment assets                              |
| `docs/`                          | Architecture, security, deployment, API, desktop notes, ADRs              |
| `scripts/`                       | Syntax check, backup and restore                                          |
| `Dockerfile`, `compose.yaml`     | Production container and Compose stack                                    |

## Tests and tooling

```bash
npm test              # Node's built-in test runner, local + cloud suites
npm run test:coverage # text coverage report
npm run lint          # ESLint
npm run format:check  # Prettier
npm run typecheck     # TypeScript contract check
npm run check         # Syntax-check every JavaScript file
```

The suite uses a deterministic mock download adapter. It covers migrations,
session hashing/expiry, cross-user isolation, CSRF/Host/Origin/body limits, SSRF
rejection, signed-link tampering and expiry, global/per-user concurrency,
cancellation, timeouts, cleanup, ZIP structure and file delivery.

Real yt-dlp/FFmpeg downloads are not run in CI because they depend on YouTube and
network access. Run a manual smoke test against the real engine before a release.

## Security and privacy

- Cloud mode uses anonymous, HttpOnly, SameSite=Lax session cookies with hashed
  tokens, CSRF tokens, Origin/Host checks, rate limits and strict security headers.
- Users are isolated by user ID in every query and every file path.
- Delivery URLs are HMAC-signed, scoped to one user/job/track and expire with the
  job. Server filesystem paths never appear in API responses.
- YouTube cookie extraction is unavailable in both modes. Native folder pickers,
  arbitrary server paths and local tag-edit-by-path endpoints are unavailable in
  cloud mode.
- Thumbnails are fetched only from an allow-list of YouTube image hosts, without
  redirects, with a size cap.
- The cloud app stores media on the server for the retention period. The server
  operator can access those files. Do not upload content you cannot legally store.

Report vulnerabilities using the process in [`SECURITY.md`](SECURITY.md). The data
policy is in [`PRIVACY.md`](PRIVACY.md) and in the app at `/privacy`.

## Known limitations

- Folder saving uses the File System Access API, so it is Chromium-only. Firefox
  and Safari use individual or ZIP downloads.
- The cloud app has no accounts or passwords; access is controlled by possession of
  the session cookie. Put it behind Cloudflare Access if you need authentication.
- Snagly is guest-only. Age-restricted, private, members-only and bot-checked
  videos may fail, and YouTube may rate-limit an IP. Keep yt-dlp updated.
- SQLite and the in-process scheduler are intended for a single app instance. Do
  not scale the service horizontally.
- Migrations are forward-only. Back up the data volume before upgrading.
- Docker image builds and Oracle deployment were not executed in the development
  environment used for this change; CI builds the image, but verify on your host.

## Scope and disclaimer

Snagly is for media you own or have the rights to download. Downloading
copyrighted content may violate YouTube's Terms of Service and local copyright
law. The author takes no responsibility for how this tool is used. Cloud mode is
self-hosted software: you are the operator and are responsible for its users,
data, retention and legal compliance.

## Credits

Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp) and
[FFmpeg](https://ffmpeg.org/). Interface type is [Inter](https://rsms.me/inter/).
