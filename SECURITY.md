# Security

Snagly is self-hosted software that downloads third-party media. This document
describes the threat model, the controls in the cloud application, the residual
risks you accept as an operator, and how to report a vulnerability.

## Supported versions

Security fixes are applied to the latest `2.x` release. The local application and
the cloud application share security-sensitive code, so update both together.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting for `whif-fler/Snagly`:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include reproduction steps, affected mode (local/cloud), version/commit, and
   impact.

You should receive an acknowledgement within a few days. Please allow time for a
fix and a release before public disclosure. Do not include real cookies, session
tokens, download tokens or personal media in a report.

## Threat model

### Assets

- Session cookies and CSRF tokens.
- Download capability URLs (HMAC tokens).
- Per-user job metadata and media files.
- The signing secret in `/data/.download-secret` (or `SNAGLY_DOWNLOAD_SECRET`).
- The host's network and the operator's cloud credentials (out of scope for the
  app, but relevant to deployment).

### Adversaries

- A remote unauthenticated attacker who can reach the public origin.
- An authenticated user of the instance trying to read another user's data.
- A malicious or compromised upstream response (YouTube metadata, thumbnails).
- A malicious filename or media title supplied through playlist metadata.
- A local user or process on the host (outside the app's trust boundary).

### In scope

- Cross-user data access (IDOR) through API, SSE, files, ZIPs or tokens.
- SSRF through URLs, thumbnails or redirects.
- Command injection through titles, filenames, formats or paths.
- Path traversal through job IDs, filenames, ZIP entries or static paths.
- XSS through titles, errors or metadata.
- CSRF, clickjacking, DNS rebinding and session fixation.
- Prototype pollution through JSON bodies.
- Resource exhaustion through large bodies, playlists, files, queues or SSE.
- Secret leakage in logs, errors, URLs or the repository.

### Out of scope

- YouTube's own security, availability or rate limiting.
- The legality of downloading specific content.
- A compromised host, Docker daemon, Cloudflare account or Oracle account.
- A user sharing their own session cookie or download URL.
- Denial of service by an operator-controlled configuration (for example,
  setting concurrency to 32 on a tiny VM).

## Controls

### Authentication and sessions

- Anonymous sessions use a 256-bit random token in an `HttpOnly`,
  `SameSite=Lax`, `Secure` (when configured) cookie.
- Only a SHA-256 hash of the token is stored in SQLite.
- Sessions expire after `SNAGLY_SESSION_TTL_DAYS` and are pruned by cleanup.
- A separate random CSRF token is required on every unsafe API request.
- There is no login endpoint, so there is no session-fixation transition. A
  session is created by the server, never supplied by the client.
- `GET /api/session` is rate limited per client IP.

### Authorization

- Every job/track read, update, retry, cancel, delete, tag edit, file and archive
  operation includes `user_id = session.userId`.
- Delivery tokens include the user and job; the route verifies both before
  touching a file.
- SSE clients are stored per user; a publish only reaches that user's connections.
- Cloud mode returns `403` for local-only endpoints (`/api/open`, `/api/browse`,
  `/api/tags/edit`). It never exposes server paths in job payloads.

### Request hardening

- Host allow-list (`SNAGLY_ALLOWED_HOSTS` plus the public origin host) rejects
  DNS-rebinding and misdirected requests with `421`.
- Origin must match the request host or `SNAGLY_PUBLIC_ORIGIN`; `Sec-Fetch-Site:
cross-site` is rejected.
- Unsafe requests require `Content-Type: application/json`, no compressed body,
  and a body under `SNAGLY_MAX_BODY_BYTES`.
- JSON parsing drops `__proto__` and `prototype` keys.
- URL length and header count/timeouts are bounded.
- Rate limits cover session bootstrap, API calls, previews, probes, retries,
  thumbnails, downloads and job creation.

### Output and browser hardening

- CSP: `default-src 'self'`, no inline scripts, no frames, no third-party
  connections, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, COOP/CORP same-origin, restrictive
  `Permissions-Policy`, and HSTS when secure cookies are enabled.
- User-controlled text is inserted with `textContent` or escaped before being
  placed in HTML attributes.
- Downloads use a sanitised `Content-Disposition` with an ASCII fallback and an
  RFC 5987 encoded filename.
- Served media types come from an extension allow-list; unknown files are never
  served.

### Input and filesystem

- Only `youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be` and
  `www.youtube.com` are accepted, over HTTPS, without credentials or custom ports.
- Thumbnails are limited to an allow-list of Google/YouTube image hosts, fetched
  without redirects, with an 8-second timeout, a 5 MB cap and image-only types.
  The on-disk thumbnail cache is byte-capped and prunes oldest files first.
- Folder names and filenames are sanitised for Windows and POSIX, length-limited,
  and stripped of control characters and path separators.
- File paths are resolved and checked with `isPathInside`; user and job IDs are
  validated before use.
- Only completed tracks with known media extensions can be downloaded.

### Subprocesses

- yt-dlp and FFmpeg are spawned with `shell: false` and argument arrays.
- Media titles and URLs are never interpolated into a shell command.
- Output is capped; timeouts and cancellation kill the process tree.
- The container runs as a non-root user with `no-new-privileges`, all capabilities
  dropped, a read-only root filesystem and a persistent data volume.
- yt-dlp is downloaded at image build time from a pinned release and verified
  against the published SHA-256 checksum.

### Resource limits

- Global and per-user concurrency.
- Maximum playlist entries, tracks per job, jobs per user, queued tracks, file
  size, archive size, job duration, request body, links per request and SSE
  connections per user.
- Streaming ZIP output avoids buffering whole archives.
- The in-memory preview cache is bounded by entry count; the thumbnail cache is
  bounded by total bytes and evicts the oldest files.
- Retention cleanup removes expired jobs and files, but skips active work.

### Secrets and dependencies

- `.env`, `cookies.txt`, `data/`, SQLite files and the signing secret are
  gitignored.
- `.env.example` contains no real secrets.
- Logs are structured JSON and do not include cookies, CSRF tokens, download
  tokens, passwords or file contents. Error responses are generic for 5xx.
- `npm ci` uses the committed lockfile; Dependabot watches npm, Docker and Actions.
- GitHub Actions use least-privilege `contents: read` permissions.

## Audit results and remediation

The migration included a repository-wide review against the requested categories.
Findings that were fixed:

| Area                | Finding                                              | Remediation                                                     |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| IDOR                | In-memory preview cache could be shared across users | Cache key includes `userId`; cleared per user                   |
| Path traversal      | Job/track IDs and filenames reached the filesystem   | Strict ID regexes, filename sanitisation, `isPathInside`        |
| SSRF                | Thumbnail proxy could be pointed at private hosts    | Host allow-list, HTTPS-only, no redirects, size/type caps       |
| Command injection   | Titles/format values could reach yt-dlp              | Argument arrays, `shell: false`, format allow-list              |
| XSS                 | Titles/errors were inserted as HTML in places        | Escaping/`textContent` throughout the UI                        |
| CSRF                | No token on unsafe API calls                         | Per-session CSRF token plus Origin/Sec-Fetch-Site checks        |
| DNS rebinding       | Any Host header was accepted                         | Host allow-list returns `421`                                   |
| Prototype pollution | JSON bodies merged into objects                      | Reviver drops `__proto__`/`prototype`; explicit field handling  |
| Races               | Two pumps could claim the same track                 | Conditional `UPDATE ... WHERE status = 'queued'` claim          |
| Cancellation        | Aborted work could still be marked done              | `updateTrackIfStatus(..., 'running')` and abort flags           |
| Cleanup             | Expired active job could be deleted                  | Cleanup skips active jobs and in-flight deliveries              |
| File delivery       | Whole ZIPs were buffered                             | Streaming ZIP writer with backpressure                          |
| Resource exhaustion | Preview and thumbnail caches grew without bound      | Preview cache capped by entries; thumbnail cache pruned by size |
| Info disclosure     | Server paths appeared in API payloads                | Serialisers emit `folder: null`, `file: null`, signed URLs only |
| Secrets             | `.env`/SQLite could be committed                     | Expanded `.gitignore`; example file only                        |
| Dependencies        | No lockfile/update policy                            | `package-lock.json`, Dependabot, CI audit via `npm ci`          |

No open high/critical application finding is known at the time of writing. The
limitations below are design constraints, not hidden defects.

## Residual risks

1. **No account authentication.** Anyone who obtains a session cookie has that
   user's library. For a public instance, put Cloudflare Access (or another
   identity-aware proxy) in front. Do not treat the app as an internet-facing
   multi-tenant service without an authentication layer.
2. **Bearer download URLs.** A signed file or ZIP URL grants access to that one
   file until it expires, even without a cookie. Treat URLs as secrets.
3. **Server operator access.** The operator can read `/data`, including media and
   metadata. This is inherent to server-side processing and retention.
4. **Upstream trust.** yt-dlp, FFmpeg and YouTube responses are third-party code
   and data. Keep the image and yt-dlp pinned/updated; do not run untrusted
   plug-ins.
5. **YouTube blocking.** The server's IP may be challenged or rate-limited.
   Cloud mode deliberately does not use personal cookies; availability is not
   guaranteed.
6. **Single-instance SQLite.** Multiple replicas would break queue and cleanup
   assumptions. Do not scale horizontally.
7. **Browser capability.** Folder saving requires the File System Access API
   (Chromium). Other browsers use standard/ZIP downloads.
8. **Deployment not exercised here.** The development environment had no Docker
   CLI and no Oracle account. CI builds the image; the operator must verify the
   host, DNS, TLS, backup and restore before inviting users.
9. **Local mode unchanged.** The local app still listens on loopback and uses the
   Windows filesystem. Do not expose `server.js` to a network.

## Operator checklist

- [ ] `SNAGLY_PUBLIC_ORIGIN` and `SNAGLY_ALLOWED_HOSTS` match the real hostname.
- [ ] `SNAGLY_DOWNLOAD_SECRET` is random and stored outside Git.
- [ ] Cloudflare Tunnel is the only public ingress; port 4174 is not exposed.
- [ ] Cloudflare Access or another auth layer protects a public instance.
- [ ] Backups are tested; restore requires `FORCE=1` and replaces all data.
- [ ] Retention and size limits match the VM's disk.
- [ ] Logs are shipped/rotated and never contain tokens or cookies.
- [ ] A manual real-engine download works before inviting users.
- [ ] The legal basis for storing/downloading content is understood.
