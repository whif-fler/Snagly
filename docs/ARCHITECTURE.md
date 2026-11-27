# Architecture

Snagly is a modular monolith. The local Windows application and the self-hosted
cloud application share domain code, while each keeps its own runtime shell. This
document explains the boundaries, the cloud data model, and the decisions that
matter for security and operations.

## Goals

- Keep the existing vanilla UI and local behaviour.
- Add secure multi-user isolation without microservices, React or Kubernetes.
- Store cloud state in SQLite with versioned migrations.
- Deliver files in three ways: browser folder saving, standard downloads, and a
  future Electron interface.
- Keep a single origin so cookies, CSP and CSRF checks stay simple.
- Allow a future desktop shell to reuse the same core and delivery URLs.

## Runtime modes

| Mode  | Entrypoint                                    | Storage                      | Delivery                                           |
| ----- | --------------------------------------------- | ---------------------------- | -------------------------------------------------- |
| Local | `server.js`                                   | `data/state.json`            | Writes to a chosen Windows folder                  |
| Cloud | `apps/server/src/main.js`                     | SQLite + `data/cloud/users/` | Signed file/ZIP URLs, optional browser folder save |
| Test  | `apps/server` with `SNAGLY_MEDIA_ENGINE=mock` | Temporary directory          | Same as cloud                                      |

The browser UI is identical. It calls `GET /api/session`; the local server does
not implement that route, so the UI stays in local mode. The cloud server
returns capability flags, and the UI hides or relabels controls that cannot work.

## Workspace layout

```
apps/server        Cloud HTTP server, sessions, SSE, delivery
apps/web/public    Static UI shared by both modes
packages/core      Validation, ids, sanitisation, format presets
packages/config    Environment parsing and limits
packages/contracts Runtime API constants + TypeScript types
packages/platform  Executables, shell-free processes, signing, logging, fs
packages/storage   SQLite, migrations, repositories, files, ZIP
packages/media     Thumbnail proxy/cache, FFmpeg metadata
packages/download-engine  Adapters, scheduler
packages/library   Application services and public serialisers
server.js          Local HTTP server
engine.js          Local queue and yt-dlp/FFmpeg orchestration
```

Dependency direction is downward: `apps` → `library` → (`storage`, `media`,
`download-engine`) → `platform`/`core`. Shared packages never import browser or
Electron globals.

## Request flow

1. `apps/server/src/main.js` loads configuration, opens SQLite, creates the file
   store, adapter, scheduler and HTTP server, then starts listening.
2. Every request goes through security headers and a Host allow-list.
3. Static assets are served from `apps/web/public` with path containment checks.
4. `GET /api/session` creates an anonymous user + session if needed and returns
   CSRF and capability data.
5. Unsafe `/api/*` requests require a valid session, same-origin Origin,
   `Sec-Fetch-Site` not `cross-site`, a matching `X-CSRF-Token`, an
   `application/json` body and a bounded body size.
6. The library service checks ownership and limits, writes jobs/tracks, and wakes
   the scheduler.
7. The scheduler claims queued tracks transactionally, runs the media adapter
   with an `AbortController`, updates progress, and refreshes job state.
8. SSE publishes a per-user snapshot on a short debounce.
9. Delivery routes verify an HMAC token (or a session cookie) and re-check that
   the job belongs to the token's user before streaming.

## Data model

SQLite runs in WAL mode with foreign keys enabled. Migrations are ordered and
recorded in `_migrations`; they are applied inside a transaction.

```
users(id, created_at, last_seen_at)
sessions(token_hash PK, user_id FK, csrf_token, created_at, expires_at)
jobs(id PK, user_id FK, source_url, playlist_key, playlist_id, title, thumb,
     folder_name, status, single, is_video, format, collection, created_at,
     finished_at, expires_at, error, total_bytes)
tracks(id PK, job_id FK, user_id FK, idx, video_id, title, artist, album,
       status, phase, progress, speed, eta, size, filename, error, warning,
       attempts, started_at, completed_at, UNIQUE(job_id, idx))
user_settings(user_id FK, key, value, PK(user_id, key))
```

Foreign keys cascade on user and job deletion. Every job/track query includes the
owning `user_id`; there is no query that looks up a job by ID alone on behalf of a
user session. The scheduler uses internal `job_id` lookups, but it never serves
those rows to an HTTP caller without an ownership check.

Sessions store only a SHA-256 hash of the random bearer token. The CSRF token is
stored separately and returned to the browser. A stolen database cannot be used
to authenticate without also obtaining the raw cookie.

## Isolation

- **Rows:** repositories require `userId` for every user-facing read/write.
- **Files:** each user gets `<downloadDir>/<userId>/<jobId>/`. IDs are validated
  and paths are resolved, then checked with `isPathInside`. Filenames are
  sanitised, and only allow-listed media extensions can be served.
- **Events:** the SSE hub keys connections by `userId`; publishing for one user
  never iterates another user's clients.
- **Delivery:** signed payloads contain `{ u, j, t? }`. The route rejects a token
  whose `j` does not match the URL, whose `t` does not match a track URL, or whose
  `u` does not own the job. Session-based delivery performs the same ownership
  check.
- **Settings:** pause and video preference are per user.

## Queue and lifecycle

The scheduler is in-process and uses SQLite as the source of truth.

- `pump()` starts tracks while global and per-user concurrency allow it.
- `claimTrack` uses a conditional `UPDATE ... WHERE status = 'queued'` so two
  pumps cannot claim the same row.
- Each worker has an `AbortController` and a maximum duration timer.
- Cancellation aborts running workers and marks queued tracks cancelled.
- On startup, any `running` track from a previous process is reset to `queued`
  (or failed if it exceeded its attempt budget).
- `refreshJob` recomputes status from track counts and sets `expires_at` when the
  job reaches a terminal state.
- Cleanup removes expired jobs and their directories, but skips any job with an
  active worker or in-flight delivery.
- Sessions are pruned on the same cleanup interval.
- The preview cache is bounded by entry count, and the thumbnail cache is pruned
  by total size when new images are written.

SQLite is single-node by design. Running more than one app replica against the
same database would duplicate schedulers and is not supported.

## Delivery

Three strategies share one server-side model:

1. **File System Access API:** the browser stores a directory handle in
   IndexedDB, requests `readwrite` permission, and streams each signed file URL
   into a writable file. Saved track IDs are kept in `localStorage` so the UI can
   distinguish "downloaded on the server" from "saved on this device".
2. **Standard downloads:** each completed track has a signed, expiring
   `/api/jobs/:job/files/:track?token=...` URL. A job archive is a streaming ZIP
   at `/api/jobs/:job/archive?token=...`, built without buffering the whole file
   in memory.
3. **Electron (future):** the shell can call the same signed URLs and expose
   native save/reveal methods. See `docs/DESKTOP-INTEGRATION.md`.

Signed URLs are bearer capabilities scoped to one user/job/track. They are safe to
hand to a download manager, but they should not be logged or shared.

## Security boundaries

- Cloudflare Tunnel terminates public TLS; the container binds to loopback.
- `Host` must be in `SNAGLY_ALLOWED_HOSTS` (or the public origin host).
- `Origin` must match the request host or the configured public origin.
- All unsafe API calls require a per-session CSRF token.
- Request bodies are limited, JSON-only and prototype-pollution filtered.
- Rate limits apply to session bootstrap, API calls, previews, probes, retries,
  thumbnails, downloads and per-user creation.
- CSP denies inline scripts, frames, objects and third-party connections.
- Thumbnails come from an allow-list, with redirects disabled and a byte cap.
- yt-dlp and FFmpeg run without a shell; arguments are arrays, output is capped,
  and process trees are killed on timeout/cancel.
- Neither mode reads `cookies.txt` or browser cookie stores. Cloud mode also
  rejects arbitrary paths and returns `403` for the local-only `/api/open`,
  `/api/browse` and `/api/tags/edit` endpoints.

## Failure and recovery

- Interrupted workers are recovered on startup.
- A worker timeout marks the track failed instead of hanging the queue.
- Failed/cancelled tracks can be retried individually or as a job.
- Expired jobs return `410` and are removed by cleanup.
- If the database cannot be opened or migrated, startup fails loudly rather than
  serving partial state.
- Graceful shutdown stops accepting connections, aborts workers, waits briefly,
  then exits; Compose allows 30 seconds.

## Deliberate trade-offs

- **Anonymous sessions** keep onboarding friction at zero. If authentication is
  required, put Cloudflare Access in front, or add accounts later using the
  existing `users.id` ownership column.
- **`node:sqlite`** avoids native npm builds and keeps the image small, but it ties
  the project to Node ≥ 22.13.
- **In-process queue** is simple and adequate for a single small VM; it is not a
  distributed job system.
- **Server-side retention** is required because browsers cannot be trusted to
  fetch at arbitrary later times. The retention window is the user's chance to
  save files, not permanent storage.
- **No transcoding of already-downloaded files for delivery**; files are streamed
  as stored, so range requests and ZIP streaming stay cheap.
