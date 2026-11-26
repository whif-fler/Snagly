# ADR 0004: Signed, expiring download URLs

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Browsers, download managers and a future Electron shell need to fetch completed
files. Requiring a cookie on every byte makes standard download flows awkward and
couples delivery to the browser session. Exposing raw filesystem paths or
unauthenticated job IDs would create IDOR and information-disclosure risks.

## Decision

Issue HMAC-SHA256 tokens containing:

- `u` — user ID;
- `j` — job ID;
- `t` — track ID (file links only);
- `exp` — expiry, capped by the job's expiry and a short TTL.

The delivery route verifies the signature, the URL/job/track match, the token's
user, and job ownership. If no token is present, a session cookie plus ownership
is accepted. Tokens are bearer capabilities, never logged.

## Consequences

- Standard downloads and desktop/CLI clients work without a cookie.
- Any holder of a URL can fetch that one file until it expires; URLs are secrets.
- Rotating the signing secret invalidates outstanding links.
- No server path or cross-user metadata is exposed.
- Tokens do not replace authorization for API mutations; those still use session
  - CSRF.
