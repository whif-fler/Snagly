# ADR 0006: Vanilla web UI and File System Access saving

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

The existing UI is plain HTML/CSS/JS with a distinctive filmstrip and waveform
design. A framework rewrite would add a build step and risk visual regressions.
Cloud users need a way to move finished files from the server to their device.

## Decision

- Keep the existing vanilla UI in `apps/web/public`.
- Detect cloud mode through `/api/session` and hide/relabel local-only controls.
- Use the File System Access API (`showDirectoryPicker`, directory handles in
  IndexedDB) for Chromium folder saving.
- Provide individual signed file downloads and a streaming ZIP for every browser.
- Track "saved on this device" separately from "download completed on the server".

## Consequences

- No bundler, framework or client build.
- Chromium gets the best experience; Safari/Firefox fall back to ZIP/files.
- Folder permissions can be revoked by the browser and must be re-requested.
- IndexedDB handle support varies; failures fall back without blocking downloads.
- A future Electron shell can replace the browser save layer with native dialogs
  through the contract in `docs/DESKTOP-INTEGRATION.md`.
