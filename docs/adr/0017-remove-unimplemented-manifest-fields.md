# ADR-0017: Remove unimplemented per-repository manifest fields

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** @sinke237

## Context and Problem Statement

The repository manifest (`RepositoryManifestEntrySchema`) and the persisted catalog record
(`RepositoryCatalogRecordSchema`) accepted per-repository `embeddingProfile` and
`refreshIntervalMinutes` fields. Neither was consumed anywhere: the worker factory in `cli.ts` builds
every worker from the single global `config.embedding.*` client regardless of `embeddingProfile`,
and nothing schedules a refresh from `refreshIntervalMinutes`. An operator who set a different
`embeddingProfile` silently got the global model; a configured `refreshIntervalMinutes` did nothing.
A configurable-looking field that changes nothing is worse than an absent one — it implies a
capability that does not exist. Should these fields be wired up or removed?

## Decision Drivers

- The config surface should not advertise knobs that have no effect
- Wiring per-repository embedding profiles and a refresh scheduler are real features with their own
  design surface (a profiles map, per-profile clients, a timer/scheduler), not a small follow-up
- `structuralOnly` is genuinely implemented (it selects whether a worker gets an embedding client)
  and must stay
- These two fields were introduced in this same change set and have not shipped, so removing them
  breaks no existing configuration

## Considered Options

- Wire `embeddingProfile` to per-repository embedding-client selection and implement a refresh
  scheduler for `refreshIntervalMinutes`
- Remove both no-op fields until the features that would consume them exist
- Leave them in place and document that they are not yet implemented

## Decision Outcome

Chosen option: **remove both no-op fields**. `embeddingProfile` and `refreshIntervalMinutes` are
dropped from the manifest schema, the catalog record schema, `reconcileManifest`,
`toSafeRepositoryConfig`, the legacy worker record in `context.ts`, `RepositoryRegistration` in
`provisioning.ts`, and the test fixtures. `structuralOnly` is kept because it is wired
(`repository.structuralOnly ? undefined : embeddingClient` in the worker factory). Because the two
removed fields are new and unshipped, removing them from the `.strict()` manifest schema cannot
reject any existing operator config; the non-strict catalog record schema simply stops emitting them
on the next write. If per-repository embedding profiles or scheduled refresh are built later, they
return as fields backed by real behavior.

### Consequences

- Good, because the manifest no longer implies model-selection or refresh capabilities that do not
  exist
- Good, because no migration is needed — the fields never shipped, so nothing depends on them
- Bad, because a future implementation must re-add the fields (and their schema/tests), rather than
  finding placeholders already present
- Neutral, because `structuralOnly` and `autoIndex` remain; only the two genuinely inert fields were
  removed

## Pros and Cons of the Options

### Wire the fields up

- Good, because the config surface would then be fully honored
- Bad, because it is a multi-part feature (profiles map, per-profile embedding clients, a refresh
  scheduler) far larger than the hardening change this belongs to

### Remove the no-op fields

- Good, because the config surface tells the truth about what the tool does
- Bad, because the capability has to be reintroduced deliberately later

### Leave them in and document "not implemented"

- Good, because it needs no code change
- Bad, because operators still set values that silently do nothing, which documentation rarely
  fully prevents

## More Information

- Related code: `packages/server/src/config/schema.ts`, `packages/server/src/catalog/schema.ts`,
  `packages/server/src/catalog/store.ts`, `packages/server/src/catalog/provisioning.ts`,
  `packages/server/src/mcp/context.ts`.
- Related: ADR-0007 (portable configuration object).
