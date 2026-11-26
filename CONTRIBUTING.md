# Contributing

Thanks for helping improve Snagly. The project deliberately stays small: vanilla
HTML/CSS/JS, Node's standard library, SQLite, and a single container.

## Before you start

- Open an issue for anything larger than a typo or a tiny fix.
- Do not add React, Next.js, a bundler, a CSS framework, a microservice or
  Kubernetes. If a dependency is genuinely necessary, explain the trade-off.
- Do not commit `data/`, `.env`, `cookies.txt`, SQLite files, downloaded media,
  session tokens or secrets.
- Do not weaken a security check, test or limit to make a test pass.

## Setup

```bash
git clone https://github.com/whif-fler/Snagly.git
cd Snagly
npm install
```

Run the local app:

```powershell
node server.js
```

Run the cloud app with the deterministic mock engine:

```bash
SNAGLY_MEDIA_ENGINE=mock SNAGLY_DATA_DIR=./data/dev node apps/server/src/main.js
```

On PowerShell:

```powershell
$env:SNAGLY_MEDIA_ENGINE='mock'
$env:SNAGLY_DATA_DIR='./data/dev'
node apps/server/src/main.js
```

The cloud server listens on `127.0.0.1:4174` by default. The local server uses
`127.0.0.1:4173`.

## Checks

Run these before opening a pull request:

```bash
npm run check
npm run lint
npm run typecheck
npm run format:check
npm test
```

`npm run format` rewrites files with Prettier. Keep the repository clean after it.

## Tests

- `test/` contains the original local-mode tests.
- `tests/` contains cloud storage, API, isolation, security, scheduler and
  end-to-end tests.
- Tests use Node's built-in runner and a temporary data directory.
- The cloud tests use `SNAGLY_MEDIA_ENGINE=mock`; they must not require YouTube,
  yt-dlp or FFmpeg.
- Real download smoke tests are manual. If you add one, keep it out of the default
  `npm test` run and document the environment it needs.

When fixing a security issue, add a regression test that fails without the fix.
When changing the API shape, update `packages/contracts/contracts.ts` and
`docs/API.md` in the same change.

## Code style

- CommonJS in Node packages and the browser script.
- Two-space indentation, single quotes, semicolons (Prettier enforces this).
- Prefer small pure functions in `packages/core` and explicit validation at the
  HTTP boundary.
- Never include user data in error messages returned to another user.
- Keep comments explanatory, not decorative. Document non-obvious security
  decisions.

## Database changes

1. Add a new ordered migration in `packages/storage/migrations.js`; never edit an
   applied migration.
2. Add repository tests that cover upgrade from the previous schema.
3. Update `docs/ARCHITECTURE.md` if the data model changes.
4. Note the change in `CHANGELOG.md`. Migrations are forward-only, so mention the
   backup/rollback implications.

## API changes

- Cloud endpoints are versioned through `API_VERSION` and the capability payload.
- Additive changes are preferred. If you must change a shape, add a new field or
  version rather than silently changing an existing one.
- Keep local-only routes out of cloud mode; return `403` with a clear message.
- Update `docs/API.md` and the TypeScript contract.

## UI changes

- Preserve the existing visual identity: typography, spacing, colours, filmstrip,
  waveform and modal patterns.
- Test light and dark themes, keyboard focus, reduced motion and narrow screens.
- Hide a control when the capability is unavailable rather than letting it fail
  on click.
- Any new HTML insertion must escape user-controlled text.

## Security

- Treat every URL, title, filename, ID, body field and upstream response as
  untrusted.
- Use `runProcess` (no shell) for external tools.
- Use `isPathInside` and the file store for paths.
- Add rate/body/size limits for new expensive endpoints.
- Update `SECURITY.md` if the threat model or a control changes.

Report a vulnerability privately as described in `SECURITY.md`; do not open a
public issue.

## Commits and releases

- Keep commits focused and use the imperative mood, for example
  `Add signed ZIP delivery`.
- Update `CHANGELOG.md` under `Unreleased` for user-visible changes.
- Version numbers follow semantic versioning. The API has its own `API_VERSION`.
- Tag releases after CI is green and the Docker image builds.
