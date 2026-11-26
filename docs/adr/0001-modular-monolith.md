# ADR 0001: Modular monolith with npm workspaces

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Snagly began as a dependency-free local Node app. The cloud version needs shared
validation, storage, media and queue logic, but the team and deployment target are
small. Microservices, React/Next.js and Kubernetes would add operational cost
without solving a current problem.

## Decision

Use a single repository and a modular monolith:

- npm workspaces under `apps/*` and `packages/*`;
- CommonJS packages with explicit dependency direction;
- one HTTP server process, one SQLite database, one container;
- the original local app stays at the repository root.

## Consequences

- One deployable, one log stream, one backup target.
- Shared code is importable without a build step.
- Boundaries are enforced by convention and review, not network calls.
- Horizontal scaling is intentionally unsupported; SQLite and the scheduler assume
  one process.
- A future extraction of a service is possible but not planned.
