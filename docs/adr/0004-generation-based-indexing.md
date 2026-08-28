# ADR-0004: Generation-based indexing lifecycle

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** project maintainers

## Context and Problem Statement

Reindexing a repository can fail partway through — a crashed process, a down embedding provider, an
interrupted extraction. Retrieval must still work against the last good index while a rebuild is in
progress or after a rebuild fails. How should the storage layer represent "an index build in
progress" without ever leaving retrieval in a broken state?

## Decision Drivers

- A failed or interrupted rebuild must never destroy the last usable index
- Concurrent readers must be able to query while a rebuild runs
- Only one process should be allowed to build a new index for a given database at a time
- Crash recovery must be automatic on the next process start, not a manual repair step

## Considered Options

- Overwrite the active index in place as extraction/embedding progresses
- Build a new, fully separate "generation" and atomically activate it only once complete, using a
  lease to coordinate ownership across processes

## Decision Outcome

Chosen option: **generation-based indexing**. A reindex creates a new generation in a `BUILDING`
state, extracts and persists into it, accepts embedding batches, and only flips it to `ACTIVE` (and
the previous generation to `OBSOLETE`) inside one transaction once complete. A lease row records
which process owns the currently building generation, with a heartbeat and expiry so an abandoned
build is recoverable by the next process to start, rather than left stuck.

### Consequences

- Good, because an embedding-provider outage or a crash mid-build marks the generation `FAILED` or
  `ABANDONED` without ever touching the still-`ACTIVE` prior generation
- Good, because two processes racing to reindex the same database is a detectable, handled
  condition rather than silent corruption
- Bad, because old generations must eventually be pruned, or a database can grow without bound —
  not yet implemented
- Neutral, because status reporting has to distinguish "no generation has ever gone active" from "a
  rebuild is in progress but a usable one already exists," which is more states than a single
  boolean "is indexed" flag

## Pros and Cons of the Options

### Overwrite in place

- Good, because it is the simplest possible storage model
- Bad, because a crash or failure mid-write leaves the index in an unknown, possibly unusable state
- Bad, because a concurrent reader could observe a half-written index

### Generation-based, lease-coordinated

- Good, because the last good index is provably untouched by an in-progress or failed rebuild
- Good, because ownership of an in-progress build is explicit and recoverable
- Bad, because it requires more schema (a lease table, per-generation scoping on every query) than
  the in-place alternative

## More Information

See ADR-0002 for the storage engine this lifecycle is implemented on top of.
