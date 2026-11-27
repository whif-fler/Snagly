# HTTP API (v1)

The cloud server exposes a single-origin JSON API for the browser client and a
future desktop shell. `API_VERSION` is `1`; additive fields may appear without a
version bump. The TypeScript contract lives in
`packages/contracts/contracts.ts`.

## Base URL

- Cloud: `https://<your-host>` (behind Cloudflare Tunnel)
- Local development: `http://127.0.0.1:4174`

The local Windows app (`server.js`) keeps its original unversioned API and does
not implement `/api/session` or the delivery routes below.

## Authentication

1. `GET /api/session` creates an anonymous user/session if needed and returns a
   CSRF token. The session cookie is `snagly_sid`, `HttpOnly`, `SameSite=Lax`,
   and `Secure` when configured.
2. Send the cookie on every request.
3. Send `X-CSRF-Token: <csrfToken>` on every `POST`, `PUT`, `PATCH` or `DELETE`.
4. Unsafe requests must use `Content-Type: application/json`, must not be
   cross-site, and must have an allowed `Origin` (when present).

There are no passwords or account endpoints. Put Cloudflare Access in front if you
need authentication.

### Errors

```json
{ "error": "Human-readable message", "code": "rate_limited" }
```

| Status | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| `400`  | Invalid input, unsupported URL/format                            |
| `401`  | Missing or expired session                                       |
| `403`  | CSRF/Origin failure, invalid download token, local-only endpoint |
| `404`  | Missing job/track, or not owned by this user                     |
| `409`  | Job is still running and cannot be removed                       |
| `410`  | Job/file link expired                                            |
| `413`  | Body, file, archive or response too large                        |
| `415`  | Wrong content type or unsupported thumbnail type                 |
| `421`  | Host header not allowed                                          |
| `429`  | Rate limit or per-user limit; see `Retry-After`                  |
| `500`  | Unexpected server error (details are logged, not returned)       |

## Capabilities

`GET /api/session` and `GET /api/config` return:

```json
{
  "mode": "cloud",
  "localFolderPicker": false,
  "serverTagEditing": true,
  "fileSystemAccess": true,
  "standardDownloads": true,
  "zipDownload": true,
  "arbitraryServerPaths": false
}
```

The client must hide a feature when its capability is `false`.

## Session

### `GET /api/session`

Rate limited per client IP. Creates a session if no valid cookie is present.

```json
{
  "apiVersion": "1",
  "user": { "id": "usr_..." },
  "csrfToken": "...",
  "capabilities": { "...": true },
  "retentionHours": 24,
  "limits": {
    "globalConcurrency": 4,
    "perUserConcurrency": 2,
    "maxPlaylistEntries": 500,
    "maxLinksPerRequest": 20,
    "maxFileMb": 4096
  }
}
```

### `GET /api/config`

Same capability/limit data without creating a session.

### `GET /api/status`

Per-user runtime status: `mode`, `apiVersion`, `paused`, `workers`, `active`,
`queued`, `retentionHours`, `capabilities`, `tools: { yt, ffmpeg }`.

## Jobs

### `GET /api/jobs`

```json
{
  "jobs": [
    {
      "id": "job_...",
      "url": "https://www.youtube.com/playlist?list=...",
      "sourceUrl": "https://www.youtube.com/playlist?list=...",
      "playlistId": "PL...",
      "title": "Playlist title",
      "thumb": "https://i.ytimg.com/...",
      "folderName": "Playlist title",
      "folder": null,
      "albumTag": "Playlist title",
      "status": "running",
      "single": false,
      "isVideo": false,
      "format": "mp3",
      "trackCount": 12,
      "done": 3,
      "failed": 0,
      "cancelled": 0,
      "missing": 0,
      "running": 1,
      "queued": 8,
      "createdAt": "2026-11-27T10:00:00.000Z",
      "finishedAt": null,
      "expiresAt": null,
      "expired": false,
      "totalBytes": 12345678,
      "archiveUrl": null,
      "tracks": [
        {
          "id": "trk_...",
          "index": 1,
          "videoId": "dQw4w9WgXcQ",
          "title": "Track title",
          "artist": "Artist",
          "album": "Playlist title",
          "status": "done",
          "phase": null,
          "progress": 100,
          "speed": "",
          "eta": null,
          "size": 8123456,
          "filename": "01 - Track title.mp3",
          "file": null,
          "error": null,
          "warning": null,
          "completedAt": "2026-11-27T10:01:00.000Z",
          "downloadUrl": "/api/jobs/job_.../files/trk_...?token=..."
        }
      ]
    }
  ],
  "status": { "...": "..." }
}
```

`folder` and `file` are always `null` in cloud mode. Use `downloadUrl` or
`archiveUrl`; they are signed and expire with the job. `archiveUrl` appears once at
least one track is done.

### `POST /api/jobs`

Creates jobs from one or more links. Rate limited and subject to per-user limits.

```json
{
  "items": [{ "url": "https://youtu.be/dQw4w9WgXcQ", "selected": [1, 2, 3] }],
  "format": "mp3",
  "isVideo": false,
  "collection": "Optional album tag",
  "allowDuplicate": false
}
```

`urls` may be used instead of `items`. `selected` is an array of 1-based track
indexes or a range accepted by the preview UI. Omit it to take every track.
`root` is accepted by the local app only; cloud mode ignores it.

Response (`201`):

```json
{
  "created": [{ "id": "job_...", "title": "...", "trackCount": 3, "isVideo": false, "format": "mp3" }],
  "errors": [{ "url": "...", "error": "...", "duplicate": true }]
}
```

### `GET /api/jobs/:id`

Returns `{ "job": { ... } }` if the job belongs to the caller; otherwise `404`.

### `DELETE /api/jobs/:id`

Removes a non-running job and its files. Returns `409` while work is active.

### `POST /api/jobs/:id/cancel`

Cancels queued tracks and aborts running workers. Returns
`{ "cancelled": 3 }`.

### `POST /api/jobs/:id/retry`

Body: `{}` to retry all failed/cancelled/missing tracks, or
`{ "trackId": "trk_..." }` for one track. Returns `{ "retried": 2 }`.

### `POST /api/jobs/:id/tracks/:trackId/tags`

Edits a completed track's metadata. Cloud mode writes the tags through FFmpeg on
the server; the client never supplies a path.

```json
{ "tags": { "title": "New title", "artist": "New artist", "album": "Album" } }
```

Only allow-listed tag keys are accepted. Returns `{ "ok": true, "tags": {...} }`.

## Preview and probe

### `POST /api/preview`

Body: `{ "urls": ["https://..."] }` or `{ "url": "https://..." }`.

Returns `{ "sources": [...], "errors": [...] }`. Each source has `url`, `title`,
`thumb`, `single`, `entries` and `formats`. Playlist size is capped by
`SNAGLY_MAX_PLAYLIST_ENTRIES`.

### `POST /api/probe`

Body: `{ "url": "https://..." }`. Returns `{ "formats": [...] }` for the video
quality selector. YouTube-only, HTTPS-only, rate limited.

## Formats

### `GET /api/formats`

Audio presets: MP3 320, MP3 V0, FLAC, Opus, M4A/AAC, best.

### `GET /api/video-formats`

Video ceilings: 360p, 480p, 720p, 1080p, 1440p, 2160p.

## Thumbnails

### `GET /api/thumb?u=<encoded-url>`

Server-side proxy/cache for an allow-listed YouTube image host. Redirects are
refused; only JPEG, PNG, WebP and GIF are accepted; the body is capped at 5 MB.
The response is cached privately for 24 hours.

## Settings and history

### `POST /api/pause`

Body: `{ "paused": true }`. Per-user; pausing stops new tracks for that user only.

### `POST /api/settings`

Body may contain `isVideo` and/or `paused`. Worker counts are ignored in cloud
mode. Returns the updated status.

The original local app also accepts `workers` and `root`. `root` must be an absolute,
writable directory; the app creates it if needed and uses it for new downloads. The
cloud server rejects or ignores `root` because users never choose server paths.

### `POST /api/cache/clear`

Clears only the caller's in-memory preview cache. Returns `{ "removed": 3 }`.

### `GET /api/history`

Returns `{ "history": [{ title, artist, album, file, completedAt, jobId, trackId }] }`.
`file` is a filename, not a server path.

## Live events

### `GET /api/events`

Server-sent events, one stream per connection and per user. Heartbeat every 15 s.

```
event: message
data: {"type":"state","jobs":[...],"paused":false,"workers":2,"active":1,"queued":3,"penaltyMs":0,"isVideo":false}
```

The client can ignore the event and refresh `/api/jobs` at any time. Events never
contain another user's jobs.

## Delivery

### `GET /api/jobs/:jobId/files/:trackId?token=...`

Streams one completed file. Supports `HEAD` and single-range requests. The token
must match the job and track; a token for a different track is rejected with
`403`. If no token is supplied, a valid session cookie plus ownership is accepted.
Expired jobs return `410`.

### `GET /api/jobs/:jobId/archive?token=...`

Streams a ZIP of all completed files in the job. The archive is generated on the
fly; files are not buffered in memory. A token must not include a track ID.

Downloads are rate limited and return `Content-Disposition: attachment` with a
sanitised filename.

## Local-only endpoints

Cloud mode returns `403` for:

- `POST /api/open` — open a path in Explorer
- `POST /api/browse` — native folder picker
- `POST /api/tags/edit` — rewrite a file by path

These remain available in the local Windows app. A future Electron shell should
replace them with native methods rather than re-enabling server paths.

## Health

### `GET /healthz`

No authentication. Runs `SELECT 1` and returns:

```json
{ "ok": true, "version": "2.0.0", "apiVersion": "1", "engine": "real" }
```

Used by Docker and the deployment checks.
