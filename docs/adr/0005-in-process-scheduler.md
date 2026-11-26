# ADR 0005: In-process scheduler backed by SQLite

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Downloads are slow, cancellable subprocesses. A separate worker service or a
message broker would add infrastructure that a single-VM deployment does not need.
The app must survive restarts and enforce global and per-user concurrency.

## Decision

Run a scheduler inside the server process:

- SQLite is the source of truth for queued/running/done tracks.
- `pump()` starts work while global and per-user slots are free.
- A conditional `UPDATE ... WHERE status = 'queued'` claims a track.
- Each worker gets an `AbortController` and a maximum-duration timer.
- Startup requeues interrupted `running` tracks.
- Cleanup removes expired jobs but skips active workers.
- Cancellation aborts workers and marks queued tracks cancelled.

## Consequences

- No extra service, broker or container.
- Restart recovery and queue state are durable.
- Only one scheduler may run against a database; horizontal scaling is invalid.
- Long-running work shares the API process; process limits and concurrency caps
  protect responsiveness.
- A future multi-node deployment would need a different scheduler and database.
