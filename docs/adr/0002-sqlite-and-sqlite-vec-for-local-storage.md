# ADR-0002: SQLite + sqlite-vec for local index storage

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** project maintainers

## Context and Problem Statement

The engine needs to persist extracted chunks, embeddings, and a structural code graph locally, and
serve both exact graph traversal and vector nearest-neighbor search against that data. What storage
should back a single local developer checkout, given the tool must run with no server daemon and no
separate installation step?

## Decision Drivers

- No local database daemon — the tool must work from a single `npx` invocation
- The structural graph's operations (find a symbol, direct callers/callees, bounded traversal,
  containment) are simple enough not to need a dedicated graph engine
- Vector search and relational metadata should be queryable together, in one place
- The storage engine must be embeddable directly inside a native addon

## Considered Options

- A graph database (e.g. an embedded or locally-run instance) plus a separate vector store
- SQLite with the `sqlite-vec` extension, linked directly into the native addon
- A flat-file/custom binary format with hand-rolled indexes

## Decision Outcome

Chosen option: **SQLite with `sqlite-vec`**, because the graph's three-relation vocabulary maps
cleanly onto indexed edge tables and recursive CTEs, vector search and relational metadata live in
one file with one connection, and there is no daemon to install, start, or keep alive.

### Consequences

- Good, because the entire index is one relocatable file
- Good, because graph queries (symbol lookup, callers, callees, bounded neighborhood) are ordinary
  indexed SQL, verified directly with real fixtures
- Bad, because `sqlite-vec` is a comparatively young extension; its query surface is deliberately
  wrapped behind a small internal API rather than exposed directly, so a future extension swap stays
  contained
- Neutral, because very large graphs may eventually need query patterns beyond what a recursive CTE
  handles comfortably — not a problem at today's scale

## Pros and Cons of the Options

### Separate graph database + vector store

- Good, because each store is purpose-built and can scale independently
- Bad, because it means running (or embedding) two storage engines instead of one, and keeping them
  consistent
- Bad, because it reintroduces the "local daemon" problem this project is explicitly avoiding

### SQLite + sqlite-vec

- Good, because one file, one connection, one transaction model for both structural and semantic data
- Good, because SQLite is one of the most battle-tested embedded databases available
- Bad, because `sqlite-vec` is a newer, smaller project than SQLite itself

### Flat-file/custom format

- Good, because it could be tuned exactly to this project's access patterns
- Bad, because it means re-implementing transactions, indexing, and crash-safety from scratch — a
  large, ongoing maintenance cost for no clear benefit over an existing embedded database

## More Information

See ADR-0004 for how generations use this storage to make reindexing crash-safe.
