# ADR-0016: Shutdown-safe worker resolution and live catalog records

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** @sinke237

> **Note:** this ADR originally also covered a startup-recovery path for repositories stuck in the
> `provisioning` lifecycle. Repository provisioning was subsequently removed to keep `lci-mcp`
> local-first ([ADR-0018](./0018-local-first-no-http-auth-provisioning.md)), so only the two
> worker-registry decisions below still stand.

## Context and Problem Statement

The multi-repository `RepositoryWorkerRegistry` (`packages/server/src/catalog/workerRegistry.ts`)
caches one `CodeIndex` worker per repository and, under the HTTP transport, resolves workers
concurrently across many in-flight tool calls while `SIGTERM` may arrive at any moment. Three
correctness gaps followed from that concurrency: a worker cached at open time keeps serving a
stale repository record (so `lci_*` envelopes report a lifecycle/`lastIndexedAt` that no longer
matches the catalog after an index commits); a `resolve()` that passed the shutdown check before its
`await` can register a brand-new worker into the map `closeAll()` already drained, leaking a SQLite
handle; and a repository left in `provisioning` because the process crashed mid-clone is skipped by
every subsequent boot with no path back to `registered`. How should worker resolution and
provisioning stay correct under concurrency and interrupted lifecycles?

## Decision Drivers

- Tool responses must reflect the current catalog record, not a snapshot frozen when the worker
  first opened
- Every worker that gets opened must be closed — including one opened during teardown
- A lifecycle interrupted by a crash must be recoverable on the next boot without manual catalog
  edits
- Fixes should be local to the registry / provisioning path and not require callers to change

## Considered Options

- Store only `repositoryId` in the worker and re-fetch the summary on every tool call
- Keep the cached worker but refresh its `repository` field from the freshly-fetched record on each
  `resolve()`
- For shutdown safety: rely on the existing entry-level `closing` check only, versus re-checking
  after the async factory
- For provisioning: leave stuck records as-is, mark them `failed`, or reset them to `registered` for
  retry

## Decision Outcome

Chosen options, three targeted changes:

1. **Refresh the record on resolve.** `resolve()` already fetches a fresh catalog record to run
   `assertAvailable` and authorization; it now also assigns that record onto the cached worker
   (`cached.repository = repository`) before returning, on both the cache-hit and post-eviction
   paths. Envelopes therefore report live lifecycle/state. This keeps the worker (and its open
   `CodeIndex`) cached while making the metadata current — cheaper than re-opening, more correct than
   a frozen snapshot.
2. **Re-check `closing` after the factory.** `openWorker()` re-reads `this.closing` **after** the
   async factory resolves; if teardown began while the factory awaited, it closes the just-created
   resources and throws instead of registering them into an already-cleared map. The existing
   entry-level check in `resolve()` remains a fast path; this post-`await` check is the correctness
   guarantee for the exact race where a worker is created after `closeAll()` took its snapshot.
3. **Recover stuck `provisioning` on startup.** `ensureProvisionedCheckouts` (`cli.ts`) treats a
   record still in `provisioning` as an interrupted previous run: it logs and transitions it back to
   `registered` (a transition the lifecycle state machine already permits), so this boot retries the
   checkout rather than leaving it wedged forever. Resetting to `registered` (retry) is preferred
   over `failed` (visible but still skipped by the provision loop) because the goal is automatic
   recovery.

### Consequences

- Good, because tool envelopes stop reporting a stale `provisioning`/`indexing` lifecycle after an
  index has actually committed
- Good, because no worker handle leaks when `SIGTERM` races an in-flight `resolve()`
- Good, because a crash mid-provision self-heals on the next start with no manual catalog surgery
- Bad, because a `resolve()` arriving during shutdown now throws "registry is shutting down" rather
  than returning a worker — correct, but callers see an error during the teardown window
- Neutral, because refreshing the record mutates the cached worker in place; the worker's opened
  resources (`CodeIndex`, embedding client) are deliberately left untouched

## Pros and Cons of the Options

### Store only `repositoryId`, re-fetch per call

- Good, because it makes staleness structurally impossible
- Bad, because every tool call pays a catalog read even on a warm worker, and callers would need the
  registry to hand back a summary separately

### Refresh the cached record on resolve

- Good, because it reuses the record `resolve()` already fetches and keeps the worker warm
- Bad, because it relies on every return path remembering to refresh (covered here on both paths)

### Entry-level `closing` check only

- Good, because it is the simplest
- Bad, because it misses the worker created after the check but before registration — the actual
  leak

## More Information

- Related code: `packages/server/src/catalog/workerRegistry.ts`, `packages/server/src/cli.ts`,
  `packages/server/src/catalog/provisioning.ts`, lifecycle transitions in
  `packages/server/src/catalog/schema.ts`.
- Builds on ADR-0009 (semantic MCP tool surface) and the multi-repository catalog it introduced.
