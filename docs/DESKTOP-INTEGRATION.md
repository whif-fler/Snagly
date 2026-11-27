# Desktop integration (Electron)

The cloud app is intentionally shaped so a future Electron shell can reuse the
same domain, storage and delivery code. This document defines that integration
surface. It is a design contract, not an implemented Electron app yet.

## Why a desktop shell

The browser can already download individual files and ZIPs, and Chromium can save
to a folder with the File System Access API. A desktop shell adds:

- native folder selection and "reveal in file manager" on Windows/macOS/Linux;
- reliable background processing without a tab;
- direct filesystem writes without repeated browser permission prompts;
- OS notifications and launch-at-login;
- a trusted place to run yt-dlp/FFmpeg locally without a remote server.

It must not reintroduce server paths or cross-user access. The shell is a local
single-user host, like the existing `server.js`, not a remote administration tool.

## Recommended architecture

```
Electron main process
├── starts the local server (server.js or a thin local host)
├── owns yt-dlp/FFmpeg child processes
├── owns the filesystem and native dialogs
└── exposes a narrow preload API to the renderer

Renderer
└── apps/web/public (unchanged HTML/CSS/JS)
```

The renderer stays sandboxed: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, and a preload script that exposes only the methods below. Do not
enable `webSecurity: false` or load remote content into the app window.

The local server can remain the HTTP boundary, or the main process can call the
shared packages directly. Starting the existing local server is the smallest
change and keeps the UI identical. In that case the shell should bind to
`127.0.0.1` on an ephemeral port and pass the origin to the window.

## Capability contract

The renderer already reads `GET /api/session`. A desktop host should return
`mode: "local"` plus explicit host capabilities. Extend the capability object
additively:

```ts
export interface HostCapabilities {
  mode: 'cloud' | 'local' | 'desktop';
  localFolderPicker: boolean;
  serverTagEditing: boolean;
  fileSystemAccess: boolean;
  standardDownloads: boolean;
  zipDownload: boolean;
  arbitraryServerPaths: boolean;

  // Desktop-only, additive:
  nativeDirectoryPicker?: boolean;
  nativeReveal?: boolean;
  nativeNotifications?: boolean;
  backgroundQueue?: boolean;
}
```

Rules:

- `arbitraryServerPaths` stays `false` unless the host strictly scopes paths to
  the user's chosen library root.
- The renderer must not send a path it received from the server back to the host
  as an arbitrary path. Prefer opaque handles/IDs.
- If a capability is missing, hide the control rather than failing on click.

## Preload API

Expose a single frozen object. Every method validates its input in the main
process; the preload is not a security boundary by itself.

```ts
// preload.ts (conceptual)
contextBridge.exposeInMainWorld('snaglyHost', {
  capabilities: () => ipcRenderer.invoke('host:capabilities'),
  chooseDirectory: () => ipcRenderer.invoke('host:choose-directory'),
  saveUrl: (url: string, suggestedName: string) =>
    ipcRenderer.invoke('host:save-url', { url, suggestedName }),
  revealFile: (fileId: string) => ipcRenderer.invoke('host:reveal-file', fileId),
  openExternal: (url: string) => ipcRenderer.invoke('host:open-external', url),
  notify: (title: string, body: string) => ipcRenderer.invoke('host:notify', { title, body })
});
```

`suggestedName` is sanitised again in the main process. `fileId` is resolved
against the local job/file store, never treated as a raw path. `openExternal`
accepts only `https:` YouTube/GitHub URLs from an allow-list.

## Saving in each mode

### Local HTTP server

- The renderer can keep using `/api/open` and `/api/browse` because they are
  local-only endpoints. The desktop host should replace them with the preload
  methods over time.
- The server writes files directly into the chosen library root.

### Cloud signed URLs

- The renderer has `downloadUrl` and `archiveUrl`.
- `saveUrl` fetches the signed URL with the session cookie and streams it to a
  temporary file, then atomically renames it into the chosen directory.
- A ZIP can be saved as-is; the host need not extract it.
- Expired links (`410`) must surface a clear "expired, re-download" message.

### Shared implementation

Keep the following in `packages/` and import them from both the cloud server and
the Electron main process:

- `packages/core` — validation, sanitisation, naming.
- `packages/storage` — jobs/tracks/files/ZIP (local or SQLite).
- `packages/download-engine` — adapters and scheduler.
- `packages/media` — tagging and thumbnails.
- `packages/platform` — process runner, signing, logging.

Do **not** import `electron` from a shared package. The shell passes callbacks or
adapters into the packages.

## Security requirements for the shell

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- A strict CSP on the local page, same as the cloud server.
- No remote module, no `webSecurity: false`, no loading arbitrary remote pages in
  the app window.
- Validate every IPC argument (type, length, allow-listed characters).
- Resolve and containment-check every file path; never accept an absolute path
  from the renderer.
- Use a temporary file plus atomic rename for saves; clean up on failure.
- Do not log session tokens, signed URLs or media titles at info level.
- Keep guest-only YouTube access; do not add cookie, password or OAuth capture.
- Keep the local server bound to loopback. Do not expose it to the LAN.
- Sign/notarize releases; publish checksums and an update manifest.

## Migration path

1. **Extract a host adapter** in the renderer: replace direct `/api/open`,
   `/api/browse` and FSA calls with a `host` object that defaults to the current
   browser implementation.
2. **Add a desktop capability response** from the local host: `mode: "desktop"`,
   `nativeDirectoryPicker: true`, `nativeReveal: true`.
3. **Implement the Electron main process** around the existing local server and
   `packages/`.
4. **Add preload APIs** for choose-directory, save-url, reveal-file, open-external
   and notifications.
5. **Reuse the cloud delivery contract** for signed URLs; add a desktop download
   path that streams to disk.
6. **Test** Windows first (the current primary platform), then macOS/Linux.
7. **Package** with Electron Forge or electron-builder; keep the Node version and
   yt-dlp/FFmpeg binaries pinned.

## What not to do

- Do not fork the UI or duplicate validation/naming rules.
- Do not expose a generic `runCommand` or `readFile(path)` IPC method.
- Do not let the renderer choose an arbitrary output directory per request; use a
  directory handle or a server-issued library root.
- Do not store the cloud session cookie in a desktop config file; use the OS
  credential store if a desktop app ever talks to a cloud instance.
- Do not silently upload local media or cookies to a remote server.
