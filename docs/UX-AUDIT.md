# Snagly UI/UX Audit

Status: implemented and verified in Chromium against the mock cloud engine and a real local yt-dlp/FFmpeg run  
Branch: `feat/snagly-2-web` (pushed)  
Baseline: `52e4d64`  
Scope: web interface and the local deletion endpoints it calls. No backend architecture, protocol, storage or Electron changes.

## Why this audit exists

Snagly 2.0 already had a working download pipeline, but the interface presented
several different capabilities as one flat surface. The composer mixed a
cloud-only guest session with a local-only YouTube cookie option, the destination
field gave no reliable feedback about what the browser would actually write, and
finished work was reduced to a percentage and a "Save to folder" link. The audit
and the resulting changes make each capability, permission and state explicit
without changing what the server is allowed to do.

## Method and evidence

- Ran the cloud server with `SNAGLY_MEDIA_ENGINE=mock` and a deterministic
  60 ms step so every stage, playlist and failure path was reproducible.
- Exercised the real interface in Chromium through the DevTools protocol at
  320, 375, 390, 768, 1024, 1440 and 1920 px, in light and dark themes.
- Used three-track mock playlists and single-video mock jobs. Mock thumbnails
  deliberately return 502 because the IDs are fake, which exposed artwork
  fallback behaviour.
- Stubbed the File System Access API handles in the page so folder states,
  auto-save, save-again, revoked permission and unsupported-browser fallback
  could be driven deterministically without writing to the real disk.
- Injected a one-off `401` on `/api/jobs` to exercise session expiry.
- Ran the legacy local app on port 4173 to confirm local mode still shows folder
  selection, guest-only access and local-only settings.
- Ran the same local app with real `yt-dlp` and FFmpeg: downloaded an MP3 at
  320 kbps and a 360p MP4 merge, loaded real YouTube artwork through `/api/thumb`,
  then deleted the MP3 through the new "Delete files" action and confirmed the
  file was gone from disk while the shared folder and other download remained.
- Re-ran the delete-all path in a fresh local data directory so the destructive
  test could not touch the audit library.
- After removing cookie sign-in, re-ran a real public download with no cookie
  arguments: "Me at the zoo" produced a 966,997-byte MP3. The status response no
  longer contains `useCookies` or `cookieSource`, and `/api/status` still reports
  yt-dlp and FFmpeg.
- Captured 60 before/after screenshots under `docs/ux-audit/`.

Deterministic mocks prove UI behaviour. The real-media run proves the local
download and deletion path. The native save picker, cloud deployment and
screen-reader use remain listed under limitations.

## What was wrong

| Area          | Before                                                                                                                                                                                      | Impact                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Connections   | The cloud composer showed a live "Use YouTube sign-in" checkbox and a "Privacy" link pressed against it. Guest use was invisible, and the control implied cloud could read browser cookies. | Users could not tell which identity was in use, and the control suggested a capability the cloud build deliberately does not have. |
| Destination   | A single "Choose a folder (or use Downloads)" field, truncated to "Choose a folder (or use D" at 390 px. No state for granted, expired, unavailable or unsupported.                         | The most failure-prone part of the flow looked like a text input.                                                                  |
| Saving        | Saving existed only as a "Save to folder" link after completion. No auto-save, saved markers, re-save, partial-failure or manual fallback copy.                                             | Users could not tell whether a file reached their device, and retries were opaque.                                                 |
| Activity      | A job collapsed queued, metadata, download, conversion, tagging and readiness into one progress line and "100% (3/3), 0/3 saved".                                                           | Long conversions looked stalled, and there was no cancellation or retry surface.                                                   |
| Library       | Finished work showed a broken image when artwork failed, no expiry state, no saved/expired distinction and only two generic filters.                                                        | The library could not answer "what is still here?" or "what did I already save?".                                                  |
| Settings      | Only a theme icon in the top bar. Download defaults, storage, connections and privacy had no home.                                                                                          | Mode-specific controls leaked into the composer instead of being explained in context.                                             |
| Mobile        | Primary icon buttons measured 34 px and segmented controls 28 px at 375 px. Labels clipped, and no settings surface existed for phone users.                                                | Targets were below a comfortable thumb size and content was lost to truncation.                                                    |
| Accessibility | No skip link; the track dialog did not contain focus; progress was visual only; faint text tokens were close to the contrast floor.                                                         | Keyboard and low-vision users had a weaker experience than pointer users.                                                          |

## Design direction

The rewrite keeps the Inter/violet identity, the paper background and the
single-composer layout. It removes extra containers instead of adding them:
state is carried by type, hairlines, colour and copy rather than stacked cards,
badges or gradients. Controls that only apply to one mode are hidden in the other
mode, and every explanation lives on the surface where the decision is made.

## Screen-by-screen changes

### Top bar and hero

- Added a Settings control beside the theme control, both 40 px on phones.
- Added a skip link and a single `h1`; the page keeps one main landmark.
- The hero copy now distinguishes server processing from saving to the device
  and no longer promises a desktop app.

### Composer and connection state

- Replaced the cloud checkbox with a status pill that always reads "YouTube:
  Guest". The pill opens Settings → Connections rather than duplicating the
  explanation in a modal.
- Both modes are guest-only. There are no cookie, `cookies.txt`, password or OAuth
  controls anywhere in the interface, and the Connections panel explains which
  videos may fail instead of implying a sign-in path.
- Duplicate submissions are detected against the current session/client list and
  the prompt says "Already in this session", which is accurate for expiring
  cloud jobs. Server-side duplicate detection still applies to non-expiring local
  jobs.
- Format and quality remain progressive: MP3/video, then the quality menu that
  matches the source. Advanced controls stay collapsed until "Choose tracks" is
  used.
- The composer footer stacks connection and track controls below 350 px so the
  320 px layout keeps full labels.

### Track selection

- Preview is explicit: source count, track count, select-all, per-track
  checkboxes with `role="checkbox"`, a live summary ("2 of 3 selected") and a
  button that states the consequence ("Download 2 tracks").
- The panel reports preview failures in place and returns focus predictably.
- The pluralisation bug in the selection toast ("Downloading 2 selected track")
  was found during journey testing and fixed.

### Destination and saving

- Destination now has explicit states: no folder, chosen, permission granted,
  permission expired/revoked, folder unavailable, unsupported browser,
  auto-save on, saving, saved, partially saved and manual fallback.
- The folder name is shown, not just a path. "Choose folder" is disabled with an
  explanation where the File System Access API is unavailable; ZIP download
  remains as the documented fallback.
- Auto-save is a stored preference and only runs when a folder handle exists and
  permission is granted. Files keep the playlist folder and numbered names
  (`Mock Playlist PL.../01 - Track.mp3`).
- Saved markers are per job and per file. "Save again" rewrites the same files;
  batch failures produce one aggregated error toast instead of one per track.
- Expiry is first-class: an expired tile says "Expired" and explains that saved
  files remain. "Download again" reuses the original link, selection and format,
  starts a new job, removes the expired entry and reports both actions.
- No success toast is shown unless the write completed. A revoked permission
  produces no writes and one actionable warning.

### Activity

- Added a stage rail: Queued → Fetching info → Downloading → Converting & tagging
  → Ready. The current stage is named in text, not only by colour.
- Added per-job progress, active count, active track with speed/ETA, and a
  static `aria-live="polite"` region so stage changes are announced without
  re-reading the whole list.
- Cancellation, retry and recovery are exposed on the job and in the detail
  modal. Cancelled and failed jobs stay visible with their reason.

### Library

- Tiles distinguish local saved, server-available, expired, running, failed,
  cancelled and unverified files. Artwork failure keeps the letter tile; the
  broken-image icon no longer appears.
- Filters cover all/saved/expired/running/failed/cancelled; search matches names
  and tracks; sort covers name and track count in both directions.
- Every filtered empty state explains which filter is active and offers a clear
  action. ZIP is disabled when the server copy is gone.
- The track detail modal carries per-track save state, expiry notice and the
  correct primary action ("Save again to folder" when everything is saved).
- Deletion is explicit and mode-aware. In local mode the modal offers both
  "Remove from library" (records only, files stay) and "Delete files" (removes
  the media this job wrote, then the library entry). In cloud mode only the
  server copy is removed, and the confirmation says saved device files are
  untouched.
- The library actions menu adds "Clear library" and, in local mode only,
  "Delete all downloads". Both aggregate failures instead of stopping on the
  first active job, and neither claims to delete files outside the recorded
  downloads.
- Each tile has a direct "Remove" action, which is the single-item version of
  library deletion. Its confirmation states whether downloaded files stay on disk.
- "Select downloads" adds a selection mode: click tiles (or Select all for the
  current filter), then "Remove" the chosen entries together. Local mode also
  offers "Delete files", which removes only the media recorded for those jobs;
  cloud mode offers server-copy removal only. Active jobs are reported as kept
  rather than silently half-deleted.

### Settings

Five tabs, with mode-inapplicable sections removed rather than disabled:

- **General** – theme (light/dark/system), finish notifications.
- **Downloads** – default format, a real duplicate-policy select (always ask /
  skip), and a note explaining that quality is chosen per source in the
  composer.
- **Storage** - folder, auto-save, retention; cloud variant explains server
  retention and device saving without exposing worker controls. The local variant
  edits the save folder in place, with Browse and Save, and says that only new
  downloads use the new path.
- **Connections** – guest-only status, the trust boundary, and live
  yt-dlp/FFmpeg/FFprobe version checks with a **Check again** action. It states
  that Snagly does not use cookies, passwords or OAuth and that some videos may
  fail, then shows the current session mode and where downloads run.
- **Privacy** – server processing, retention, cookie policy, saved-file marker
  reset.

Settings is the only connection-education surface. It traps focus, closes on
Escape, returns focus to the control that opened it, and scrolls inside the
dialog on short screens. On phones the five tabs sit in a fixed 3+2 grid so
every tab stays visible and the selected pill never changes a button's size.
Global worker/pause controls are not shown to cloud users.

### Dialogs, menus and toasts

- The track dialog, settings dialog, confirm dialog and library menu all use
  `aria-modal`, labelled titles and focus containment. Escape restores focus.
  Overlays are direct children of `body`, so they stack above the sticky topbar
  even when a short screen pushes the dialog to the top of the viewport.
- Toasts are informational only; destructive confirmations use the alert
  dialog.
- Long toasts wrap instead of clipping at 320 px.

## Design-system fixes

- Added a coherent token set for paper, surfaces, hairlines, ink, muted, faint,
  signal, success, warning and danger, with dark values that are not simple
  inversions.
- Measured contrast against the paper background:
  - Light: ink 15.46:1, muted 5.83:1, faint 4.66:1.
  - Dark: ink 15.63:1, muted 7.27:1, faint 5.22:1.
  - The dark `--faint` token was `#A9A9AE` (identical to muted) and was lowered
    to `#8E8E93` so hierarchy exists without dropping under 4.5:1.
- Standardised focus: 2 px signal outline with 2–3 px offset, and inset offsets
  for menu items and tiles. Fields that suppress the native outline now draw an
  explicit ring on `:focus-visible` instead of relying on the browser default.
- Standardised target sizes on phones: icon buttons 40×40, footer controls 40 px,
  primary download 44 px, segmented and tile actions 34 px, switches 44×24,
  modal close 38 px. Desktop density is unchanged.
- The selected navigation tab, active MP3/Video toggle and guest badge used
  `--signal` on `--signal-soft`, which measured 4.38:1. Added `--signal-strong`
  (`#4543B8` light, `#C7C5FF` dark) for text on the lavender fill: 6.61:1 and
  7.73:1. Violet fills with white text remain unchanged.
- The settings footer had a bare `span` selector that styled every nested span;
  it now targets only the direct status copy.
- Access warnings use the existing warning tokens: 7.58:1 in dark mode.
- Standardised radii, hairlines, spacing and type scale; removed the extra
  card-inside-card treatment from the composer and settings.
- Added reduced-motion handling for progress and transitions.
- Copy follows one rule: name the actor and the outcome. "Saved to device" only
  appears after the write; "expired" never implies deletion of local files.

## Journeys verified

| Journey                     | Result                                                                                                                                         | Evidence                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| First visit, empty library  | Empty state explains the next action; composer is the only focus.                                                                              | `after-1440-light.png`                                                                                                          |
| Single video download       | One track, correct title, completes through every stage.                                                                                       | `after-activity-running.png`                                                                                                    |
| Playlist download           | Three tracks, playlist folder naming preserved.                                                                                                | `after-1440-autosaved.png`                                                                                                      |
| Track selection             | 3→2 selection, live summary, correct 2-track job, singular/plural toast.                                                                       | `after-selection-panel.png`, `after-selection-download.png`                                                                     |
| Duplicate submission        | "Already in this session"; Skip leaves the job count unchanged; skip toast.                                                                    | `after-duplicate-confirm.png`                                                                                                   |
| Guest-only access           | No cookie toggle or `cookies.txt` path in the DOM; Connections shows "Guest"; a real public MP3 downloaded without cookie arguments.           | `settings-connections-guest-1440.png`, `settings-connections-guest-dark-1440.png`, `settings-connections-guest-mobile-dark.png` |
| Duplicate policy            | Settings select persisted "Skip duplicates"; re-adding the same link produced one skip toast and no extra job, in local and mock cloud modes.  | `settings-downloads-1440.png`                                                                                                   |
| Real local MP3              | 320 kbps CBR file, 19.005 s, exact 320000 b/s stream, correct title/artist tags, real artwork.                                                 | `after-real-media-1440.png`                                                                                                     |
| Real local MP4              | 360p AV1 + AAC merge, 47,286,721 bytes, 634.6 s.                                                                                               | `after-real-media-1440.png`                                                                                                     |
| Delete one download         | "Delete files" removed the real MP3 from disk, removed the library entry, and left the shared folder and the other download intact.            | `delete-files-modal-1440.png`                                                                                                   |
| Remove one download         | Tile "Remove" dropped only that library entry; the recorded MP3 stayed on disk and the other download was untouched.                           | `remove-one-confirm-1440.png`, `tile-remove-mobile.png`                                                                         |
| Change the save folder      | Settings → Storage accepted a new absolute path, rejected a relative one, created the folder, and the next real MP3 landed under the new root. | `settings-storage-folder-1440.png`, `settings-storage-folder-mobile.png`                                                        |
| Delete all downloads        | Fresh local data directory: "Delete all downloads" removed the file and the entry together.                                                    | verified via UI + filesystem check                                                                                              |
| Clear library               | Records removed in local and cloud modes; the local media file stayed on disk.                                                                 | verified via UI + filesystem check                                                                                              |
| Auto-save                   | 3 files written to `Mock Playlist PL1234567890/01…03`; tile turns saved; ZIP still offered.                                                    | `after-1440-autosaved.png`                                                                                                      |
| Manual save                 | Folder chosen, 3 files written, badge "Saved to device", action becomes "Save again".                                                          | `after-manual-save.png`                                                                                                         |
| Save again                  | Rewrites 3 files, toast "Saved 3 files to Snagly Test."                                                                                        | `after-save-again.png`                                                                                                          |
| Unsupported browser         | Folder controls hidden, ZIP fallback explained, auto-save disabled.                                                                            | `after-unsupported-browser.png`                                                                                                 |
| Revoked permission          | No writes; warning names the folder; one error toast.                                                                                          | `after-folder-revoked.png`                                                                                                      |
| Expired job                 | "Expired" badge, disabled ZIP, "Download again", saved-files notice.                                                                           | `after-library-empty-expired.png`, `after-expired-modal.png`                                                                    |
| Expired renewal             | New job created, expired entry removed, combined toast.                                                                                        | `after-expired-renewed.png`                                                                                                     |
| Session expiry              | One explanatory toast, new anonymous session, library empty, saved files untouched.                                                            | `after-session-expired.png`                                                                                                     |
| Library filters/search/sort | Saved filter, expired/running/failed/cancelled empty states, search miss, clear filters, name/track sort.                                      | `after-library-saved.png`                                                                                                       |
| Settings tabs               | All five tabs render, mode-inapplicable sections hidden, focus held, Escape restores focus.                                                    | `after-settings-*.png`                                                                                                          |
| Local mode                  | Folder path, browse, guest-only state; cloud retention hidden; no cookie controls.                                                             | `after-local-1440.png`, `after-local-settings-connections.png`                                                                  |
| Dark and light themes       | Both themes across composer, library, modals, settings and 375 px.                                                                             | `after-1440-dark.png`, `after-375-dark.png`, `after-settings-375-dark.png`                                                      |

## Responsive results

Measured after the final CSS change:

| Width | Document overflow     | Settings dialog overflow | Dialog inside viewport |
| ----- | --------------------- | ------------------------ | ---------------------- |
| 320   | none (305 px content) | none                     | yes                    |
| 375   | none (360 px content) | none                     | yes                    |
| 390   | none                  | none                     | yes                    |
| 768   | none                  | none                     | yes                    |
| 1024  | none                  | none                     | yes                    |
| 1440  | none                  | none                     | yes                    |
| 1920  | none                  | none                     | yes                    |

At 375 px the measured targets were: theme and settings 40×40, connection 40,
choose tracks 40×128, browse 40×290, download 44×290, segmented 34, tile action
34, switch 44×24, modal close 38.

## Accessibility findings

- Single `h1`, ordered headings, one `main` landmark, skip link to content.
- No duplicate IDs, no unnamed buttons and no unlabelled visible form fields in
  the audited DOM.
- Decorative artwork keeps `alt=""`; failures retain a letter placeholder that
  is not announced twice.
- Track rows expose `role="checkbox"` with `aria-checked`; the native checkbox is
  hidden from the accessibility tree but still present for form semantics.
- Activity changes are announced through a static polite live region; toasts use
  their own polite region.
- Settings, track and confirm dialogs contain Tab/Shift+Tab, close on Escape and
  restore the opener. The baseline only trapped the confirm dialog.
- Contrast passes AA for all three text tiers in both themes at the measured
  values above.
- Reduced-motion preferences disable progress transitions.
- Not done: a screen-reader pass in NVDA/JAWS/VoiceOver. Automated DOM checks and
  keyboard traversal are not a substitute.

## Tooling and tests

| Command                                                 | Result                       |
| ------------------------------------------------------- | ---------------------------- |
| `node --check apps/web/public/app.js`                   | pass                         |
| `npx eslint apps/web/public/app.js engine.js server.js` | pass                         |
| `npx prettier --check apps/web/public/app.js`           | pass                         |
| `npm run check`                                         | 49 JavaScript files checked  |
| `npm run typecheck`                                     | pass                         |
| `npm test`                                              | 50 passed, 0 failed, ~10.1 s |
| `npm audit --omit=dev`                                  | 0 vulnerabilities            |

The CSS and HTML files are not part of the repository's Prettier globs, so they
were not reformatted wholesale.

## Remaining limitations

- Docker is unavailable on this machine; the image and container runtime were
  not exercised.
- Real `yt-dlp`, FFmpeg, tagging, thumbnails and local file deletion were run on
  Windows. The cloud build was exercised only with the mock engine; a real
  multi-user cloud download was not run.
- The File System Access handles are test stubs. The Chromium permission prompt,
  real OS folder picker and browser-driven device writes were not exercised.
  The local deletion test wrote through the local engine, not the picker.
- The branch is pushed, but Oracle Cloud, Cloudflare DNS/TLS, backup, restore and
  a production deployment remain unverified. No release tag was created.
- A screen-reader pass in NVDA/JAWS/VoiceOver was not performed.
- Only Chromium was tested. Safari, Firefox, iOS Safari and Android Chrome were
  not exercised. macOS and Linux paths were not exercised.
- No automated visual-regression suite was added; screenshots are manual
  evidence.
- Google OAuth is intentionally absent. Both modes are guest-only; there is no
  cookie, `cookies.txt` or account path. A desktop build is described as future
  work, not as an existing feature.

## Files changed

- `apps/web/public/index.html` – composer, connection pill, destination states,
  activity rail, library toolbar, track modal, five-tab settings, local/cloud
  variants.
- `apps/web/public/styles.css` – tokens, state components, responsive rules,
  target sizes, focus treatment, dark theme, settings layout.
- `apps/web/public/app.js` – guest-only connection state, saving/auto-save,
  renewal, duplicate detection, session recovery, filters, modal focus, expiry,
  deletion flows, copy.
- `engine.js` / `server.js` – guest-only yt-dlp arguments and local file deletion.
- `docs/ux-audit/` – 60 before/after screenshots.
- `docs/UX-AUDIT.md` – this document.

## Screenshot index

Before: `before-1440.png`, `before-1440-light.png`, `before-1440-full.png`,
`before-1024.png`, `before-768.png`, `before-390.png`, `before-320.png`,
`before-activity.png`.

After, layout and themes: `after-1920-light.png`, `after-1440-light.png`,
`after-1440-dark.png`, `after-1024-light.png`, `after-768-light.png`,
`after-390-light.png`, `after-375-light.png`, `after-375-dark.png`,
`after-320-light.png`.

After, composer and saving: `after-1440-folder-chosen.png`,
`after-1440-autosaved.png`, `after-manual-save.png`, `after-save-again.png`,
`after-modal-saved.png`, `after-unsupported-browser.png`,
`after-folder-revoked.png`, `after-selection-panel.png`,
`after-selection-download.png`, `after-duplicate-confirm.png`.

After, activity and library: `after-activity-running.png`,
`after-library-saved.png`, `after-library-empty-expired.png`,
`after-expired-modal.png`, `after-expired-renewed.png`,
`after-session-expired.png`.

After, settings: `after-settings-general.png`, `after-settings-downloads.png`,
`after-settings-storage.png`, `after-settings-storage-saved.png`,
`after-settings-connections.png`, `after-settings-privacy.png`,
`after-settings-dark.png`, `after-settings-375.png`,
`after-settings-375-light.png`, `after-settings-375-dark.png`,
`after-settings-320.png`.

After, local mode: `after-local-first-run.png`, `after-local-1440.png`,
`after-local-settings-connections.png`.

After, guest-only and deletion: `settings-connections-guest-1440.png`,
`settings-connections-guest-dark-1440.png`,
`settings-connections-guest-mobile-dark.png`, `delete-files-modal-1440.png`,
`settings-downloads-1440.png`, `settings-downloads-mobile-dark.png`,
`after-real-media-1440.png`.

After, library selection: `selection-mode-1440.png`, `selection-mode-mobile.png`,
`selection-mode-cloud-1440.png`, `selection-remove-confirm-1440.png`,
`selection-delete-confirm-1440.png`.

After, single-item deletion and storage: `remove-one-confirm-1440.png`,
`tile-remove-mobile.png`, `settings-storage-folder-1440.png`,
`settings-storage-folder-mobile.png`.
