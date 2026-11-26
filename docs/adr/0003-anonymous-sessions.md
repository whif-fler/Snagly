# ADR 0003: Anonymous sessions instead of accounts

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

The cloud app needs user isolation, but the product is a small self-hosted tool.
Forcing account creation would add password storage, reset flows, email and
abuse-handling work before the core feature is proven.

## Decision

Create an anonymous user and session on first visit:

- 256-bit random bearer token in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie;
- store only a SHA-256 hash of the token in SQLite;
- separate random CSRF token for unsafe requests;
- session expiry and cleanup;
- every job/track/file is owned by the generated `users.id`.

For public instances, rely on Cloudflare Access or another identity-aware proxy.
Accounts can be added later without changing ownership columns.

## Consequences

- Zero onboarding friction and no password database.
- A stolen cookie grants that user's library; a shared cookie shares the library.
- There is no account recovery. Clearing site data starts a new empty library.
- The operator must add an authentication layer for untrusted public access.
- The app is not a multi-tenant SaaS and should not be marketed as one.
