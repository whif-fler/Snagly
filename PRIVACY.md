# Snagly Privacy Policy

**Last updated: 27 November 2026**

Snagly has two modes. They handle data differently, so this policy describes both.

- **Local mode** (`node server.js`) runs only on your Windows computer. No Snagly
  account, cloud or developer server is involved.
- **Cloud mode** (`apps/server`, usually in Docker) is software that someone —
  you or an operator you trust — runs on a server. That operator can access the
  server and its stored files.

Snagly contains no analytics, telemetry, advertising or third-party scripts in
either mode.

## The short version

### Local mode

- Everything stays on your computer.
- Snagly sets no cookies and has no sessions.
- The only outbound traffic is to YouTube/Google, for links you paste.
- YouTube sign-in is optional, off by default, and read locally by `yt-dlp`.

### Cloud mode

- A random session cookie identifies your browser; there are no passwords.
- The server stores your job metadata and downloaded files for a limited time
  (24 hours by default) so you can save them to your device.
- The server operator can read everything stored on the server.
- The server fetches YouTube pages and thumbnails using its own IP address. Your
  personal YouTube cookies are never used.
- Cloudflare (or your reverse proxy) and the hosting provider process network
  metadata such as IP addresses.

## Local mode data

| Location                 | Contents                                                                        | Why                                                         |
| ------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `data/state.json`        | Playlist/track titles, artists, file paths, sizes, timestamps, status, settings | Keeps the library across restarts and skips existing tracks |
| `data/state.backup.json` | Previous state file                                                             | Recovery after an interrupted write                         |
| `data/cache/`            | Playlist metadata, format probes and thumbnails                                 | Avoids repeat requests and keeps the browser off Google     |
| Your save folder         | Downloaded media with embedded tags/art                                         | The output you asked for                                    |
| Browser `localStorage`   | Theme choice and sign-in prompt answer                                          | UI preferences                                              |
| `cookies.txt` (optional) | A cookie export you place next to `server.js`                                   | Optional fallback for YouTube sign-in                       |
| `%TEMP%`                 | Short-lived files while FFmpeg rewrites tags                                    | Deleted after each write                                    |

`data/` is excluded from Git. On NTFS, Snagly restricts the folder to your Windows
account (plus SYSTEM/Administrators). It is plain JSON, not encrypted, so anyone
who can sign in as you can read it. Your Windows account is the boundary.

Local mode sets **no cookies** and has **no server-side session**.

## Cloud mode data

| Location                                              | Contents                                                                       | Why                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| SQLite database                                       | User ID, session hashes, CSRF tokens, job/track metadata, settings, timestamps | Queue, library, ownership and progress                  |
| `<data>/users/<user>/<job>/`                          | Downloaded media files                                                         | Server-side processing and delivery                     |
| `<data>/cache/thumbs/`                                | Cached thumbnails                                                              | Avoids repeat requests and keeps the browser off Google |
| `<data>/.download-secret` or `SNAGLY_DOWNLOAD_SECRET` | HMAC key for download links                                                    | Signs expiring file/ZIP URLs                            |
| Browser cookie `snagly_sid`                           | Random session token                                                           | Identifies the anonymous user                           |
| Browser `localStorage` / IndexedDB                    | Theme, saved-track flags, optional folder handle                               | UI state and browser folder saving                      |

The database stores only a SHA-256 hash of the session token, not the token
itself. Download URLs contain short-lived HMAC tokens. Anyone who obtains one can
use it until it expires, so treat those URLs as secrets.

**The server operator can access all cloud data**, including media files and job
metadata, and can inspect logs and backups. If you are not the operator, ask them
how long data is kept and who can access it.

Cloud mode never reads browser cookie stores or `cookies.txt`, and it does not
accept local filesystem paths from the browser.

## Cookies and sign-in

### Local mode

The **Use YouTube sign-in** toggle controls whether `yt-dlp` may read the YouTube
cookies already stored in your local Chrome, Edge or Firefox profile. When on:

- cookies are read on your computer, only for YouTube requests;
- they are not written into `data/state.json` or exported history;
- they are not sent to the developer or any party other than Google.

An optional Netscape-format `cookies.txt` next to `server.js` takes priority and
is used the same way. It contains credentials; never commit it.

### Cloud mode

Cloud mode does **not** use personal YouTube cookies. It uses only the server's
own requests. The only cookie Snagly sets is the `snagly_sid` session cookie,
which is `HttpOnly`, `SameSite=Lax`, and `Secure` when HTTPS is configured. It
contains a random identifier, not personal information.

## What leaves the device or server

| Destination                   | What is sent                                                | When                                   |
| ----------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| YouTube / Google              | The link you paste, the requesting IP, normal HTTP metadata | Preview, probe and download            |
| YouTube image hosts           | An image request from the Snagly server, including its IP   | When thumbnails are first shown/cached |
| Cloudflare / hosting provider | Normal network metadata (IP, TLS, request timing)           | Every cloud request                    |
| GitHub                        | A normal web request                                        | Only if you click a repository link    |

Local mode sends nothing to the developer. Cloud mode sends nothing to the
developer either; the operator is the party running the server.

**Export history** creates a CSV only when you click the button. In local mode it
contains full file paths, which can reveal your Windows username and folder
layout. In cloud mode it contains filenames and job identifiers. Review it before
sharing.

## Retention and deletion

### Local mode

- History/settings: close Snagly and delete `data/`.
- Cache/thumbnails: **Clear cache** or delete `data/cache/`.
- Media: delete the files in your save folder.
- `cookies.txt`: delete it next to `server.js`.
- Browser preferences: clear site data for the local address.

### Cloud mode

- Finished jobs and files expire after `SNAGLY_RETENTION_HOURS` (default 24) and
  are removed by scheduled cleanup.
- **Remove** in the library deletes the server copy of that job immediately.
- Cancelling or failing a job does not keep it forever; it follows the same
  retention/cleanup rules.
- Sessions expire after `SNAGLY_SESSION_TTL_DAYS` (default 30).
- Clearing site data removes the browser's session cookie and saved-folder handle,
  but does not delete server data. Use **Remove** for that, or ask the operator.
- The operator can delete the whole data volume; this is irreversible.

Backups may retain deleted data until the operator rotates them. Ask the operator
for the backup schedule.

## Third parties

- **YouTube / Google** — source of media and recipient of requests; Google's
  privacy policy applies.
- **yt-dlp** and **FFmpeg** — run on the local machine or the server.
- **Cloudflare** — optional TLS/tunnel provider in cloud mode.
- **GitHub** — only if you visit the repository.

Snagly is not affiliated with YouTube or Google.

## Children's privacy

Snagly does not knowingly collect personal information from anyone, including
children. Cloud mode stores only the anonymous session identifier and the media
metadata needed to operate the queue. An operator who needs verifiable parental
consent or age controls must add them at the deployment layer.

## Security

Cloud mode validates Host and Origin, requires CSRF tokens on unsafe requests,
isolates users by ID, signs download links, restricts thumbnails to YouTube image
hosts, runs media tools without a shell, and applies rate and size limits. See
[`SECURITY.md`](SECURITY.md) for controls and residual risks.

No system is perfect. If you find a vulnerability, report it privately as
described in `SECURITY.md`.

## Changes

If data handling changes, this document and the in-app privacy page are updated
in the same commit. The date at the top reflects the current version.

## Contact

Questions or corrections:
[open an issue](https://github.com/whif-fler/Snagly/issues).

## Legal note

Downloading content may be restricted by YouTube's Terms of Service and by
copyright law where you live. Snagly does not grant rights to any content. You and
the operator are responsible for what is downloaded, stored and shared.
