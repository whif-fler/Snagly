# Snagly Privacy Policy

**Last updated: 27 November 2026**

Snagly is a local Windows application. It runs a small web server on your own
computer and stores everything it knows in a folder next to the app. There is
no Snagly account, no Snagly cloud, no analytics, no telemetry, no advertising,
and no developer-operated server.

This document explains exactly what stays on your machine, what leaves it, and
how to delete it.

## The short version

- **Snagly does not collect or transmit personal data to the developer.**
- **Snagly sets no cookies and has no sessions.**
- The only network traffic is between your computer and **YouTube/Google**
  (through `yt-dlp`). Cover art is fetched by the local server, not by your
  browser, so the browser only talks to `127.0.0.1`.
- Your playlist history, settings and downloaded-file records live in
  `data/` beside `server.js`.
- Downloaded music and video live in the folder you choose.
- YouTube sign-in is optional, off until you enable it, and can be turned off
  at any time. When enabled, `yt-dlp` reads your YouTube cookies from your local
  Chrome, Edge or Firefox profile. Those cookies are never written into Snagly's
  state file and never sent to the developer.

## What is stored on your device

| Location | Contents | Why |
|---|---|---|
| `data/state.json` | Playlist and track titles, artist names, file paths, file sizes, timestamps, job status, settings | So the library survives a restart and already-downloaded tracks are skipped |
| `data/state.backup.json` | A copy of the previous state file | Recovery if a write is interrupted |
| `data/cache/*.json` | Playlist metadata and available-format results | Avoids asking YouTube for the same playlist on every keystroke |
| `data/cache/thumbs/` | Cached thumbnail images (one file per cover) | Lets the UI show cover art without the browser contacting Google |
| Your chosen save folder | The audio/video files Snagly downloads, with embedded tags and cover art | That is the product |
| Browser `localStorage` | `reel-theme` (light/dark), `snagly-cookie-choice` (whether you have answered the sign-in prompt) | Remembers UI preferences |
| `cookies.txt` (optional) | A Netscape-format cookie export you place in the Snagly folder yourself | Optional fallback when the browser cookie database is locked |
| `%TEMP%` | Short-lived `snagly-meta-*` and `snagly-out-*` files while FFmpeg rewrites tags | Deleted immediately after each tag write |

`data/` is excluded from Git, and Snagly restricts its Windows permissions to
your account (plus SYSTEM and Administrators) when the folder lives on NTFS. It
is plain JSON, not encrypted, so anyone who can sign in as your Windows user can
read it. Windows account security is the boundary.

## What leaves your device

Snagly itself contacts no server other than the YouTube URLs you give it. The
following requests do leave your computer:

| Destination | What is sent | When | Can you avoid it? |
|---|---|---|---|
| YouTube / Google (`youtube.com`, `googlevideo.com`) via `yt-dlp` | The link you paste, your IP address, normal HTTP metadata, and — only if YouTube sign-in is on — your YouTube cookies | When you preview or download a link | Not without giving up the app's purpose. Turn off YouTube sign-in to stop cookie use |
| YouTube image hosts (`i.ytimg.com`, `img.youtube.com`, `yt3.ggpht.com`, `lh3.googleusercontent.com`) | A normal image request from the local Snagly server, including your IP address. Your browser never contacts these hosts directly | When thumbnails or cover art are first shown, then from the local cache | Not currently configurable; the UI falls back to a letter tile if the image fails |
| GitHub (`github.com`) | A normal web request | Only if you click a repository link | Yes — do not click the link |

Snagly sends **nothing** to the developer: no usage data, no crash reports, no
identifiers, no analytics events.

**Export history** is different: it is a CSV file created only when you click
the button. It stays on your computer, but it contains the full paths of your
downloaded files, which can reveal your Windows username and folder layout.
Review it before sharing it with anyone.

## Cookies and browser sign-in

**Snagly does not set cookies.** There is no `Set-Cookie` header, no login, and
no server-side session.

The **Use YouTube sign-in** toggle controls a different thing: YouTube often
shows a "confirm you're not a bot" check. To get past it, `yt-dlp` can read the
YouTube cookies that already exist in your local Chrome, Edge or Firefox
profile. This is what the toggle enables.

When it is on:

- `yt-dlp` reads the browser's cookie database **on your computer**.
- The cookies are used only for requests to YouTube.
- They are **not** copied into `data/state.json`, logs, or exported history.
- They are **not** sent to the developer or any third party other than Google.
- If the cookie database is locked (the browser is running), the download
  continues without cookies and Snagly tells you.

Alternatively, you can export a Netscape-format `cookies.txt` with a browser
extension and place it beside `server.js`. Snagly uses it instead of the browser
database, which avoids the lock problem. That file contains your YouTube
credentials: it is listed in `.gitignore`, it is never uploaded, and you should
delete it when you no longer need it.

You can turn sign-in off at any time in the composer footer or by editing
`data/state.json` (`"useCookies": false`). On first visit Snagly asks once
whether to enable it, and it stays off until you say yes.

## No tracking, no profiles

Snagly contains no analytics SDK, no advertising SDK, no crash reporter, no
fingerprinting, and no third-party fonts or scripts. The Inter font is served
from the app's own `public/assets/fonts/` folder. The Content-Security-Policy
blocks scripts and styles from other origins.

## How to delete your data

| To delete | Do this |
|---|---|
| Playlist history and settings | Close Snagly, then delete the `data/` folder |
| Cached playlist metadata and thumbnails | Use **Clear cache** in the app, or delete `data/cache/` |
| Downloaded media | Delete the files in your chosen save folder |
| A `cookies.txt` file | Delete `cookies.txt` beside `server.js` |
| Browser preferences | Clear site data for Snagly's address (usually `localhost:4173`) in your browser |
| Everything | Delete `data/`, `cookies.txt`, your save folder, and the browser site data |

Deleting `data/` does not delete downloaded files. Deleting downloaded files
does not remove the history entries until the library is refreshed.

## Third-party services

Snagly relies on:

- **YouTube / Google** — the source of the media and the subject of your
  requests. Google's own privacy policy applies to those requests.
- **yt-dlp** and **FFmpeg** — local command-line tools installed through
  winget. They run on your machine. Each project has its own documentation.
- **GitHub** — only if you visit the repository or download a release.

Snagly is not affiliated with YouTube or Google.

## Children's privacy

Snagly is a general-purpose local tool. It does not knowingly collect personal
information from anyone, including children, because it does not collect
personal information at all.

## Security

Snagly binds its web server to `127.0.0.1`, validates the `Host` and `Origin`
headers, requires JSON request bodies, restricts the API to YouTube URLs, and
confines file operations to your library folder. Thumbnails are fetched by the
server from a small allow-list of YouTube image hosts, with redirects disabled,
so a thumbnail URL cannot be used to reach your network. See the audit notes in
the repository for details.

## Changes to this policy

If Snagly's data handling changes, this document will be updated in the same
commit as the code change. The "Last updated" date above reflects the current
version.

## Contact

Questions or corrections: open an issue at
<https://github.com/whif-fler/Snagly/issues>.

## Legal note

Downloading content may be restricted by YouTube's Terms of Service and by
copyright law in your country. Snagly is a downloader; it does not grant you
rights to any content. You are responsible for what you download and how you
use it.
