# ADR-0008: Templated storage paths

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** @leghadjeu-christian

## Context and Problem Statement

Where should a repository's local index database live by default, and how much should that location
be configurable? A repository-local path is convenient by default, but some developers and
organizations prefer a shared cache or temp location, and different MCP hosts may launch the tool
from different working directories.

## Decision Drivers

- A sensible default should require no configuration at all
- Some environments need the database somewhere other than inside the repository (shared cache,
  per-commit snapshots, avoiding accidental commits of the database file)
- An unresolvable path should be a loud, immediate configuration error, never a silent
  fallback to literal unresolved text

## Considered Options

- A single fixed default location relative to the repository root, no further configurability
- A small template language over the storage path, with a fixed, documented set of variables

## Decision Outcome

Chosen option: **a small template language**. The configured `storage.database` path may contain
`{{repoRoot}}`, `{{repoName}}`, `{{repoKey}}`, `{{headSha}}`, `{{shortHeadSha}}`, `{{homeDir}}`,
`{{dataDir}}`, and `{{tmpDir}}`. An operator who wants a repository-local, shared-cache, or
per-commit database layout can express any of them directly in configuration. An unknown variable
is a hard configuration error at expansion time.

> The default itself moved from a repository-local path to `{{dataDir}}`-based one — see
> [ADR-0012](./0012-index-and-storage-safety-boundaries.md). The templating mechanism described
> here, and every variable except `{{dataDir}}`, is unchanged by that.

### Consequences

- Good, because the common case (repository-local database) needs zero configuration
- Good, because a shared-cache or per-commit layout is expressible without code changes
- Bad, because `repoKey` must be a stable, well-tested identifier before this is safe to rely on —
  changing its derivation later silently relocates every existing user's default database
- Neutral, because per-commit database paths are supported but not recommended as a default, since
  garbage-collecting old per-commit files becomes the user's own responsibility

## Pros and Cons of the Options

### Fixed default location only

- Good, because there is nothing to get wrong in a template expansion
- Bad, because it cannot express a shared-cache or per-commit layout without a code change

### Small template language

- Good, because it covers the known real use cases with one mechanism
- Bad, because it adds a template-expansion step, and with it a new class of error (an unknown
  variable) that must be surfaced clearly rather than silently ignored

## More Information

See ADR-0007 for the configuration system this path lives inside.
