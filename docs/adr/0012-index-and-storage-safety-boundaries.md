# ADR-0012: Index and storage safety boundaries

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** @leghadjeu-christian
- **Supersedes:** ADR-0008's choice of `{{repoRoot}}` as the default storage path (the templating
  mechanism itself is unchanged)

## Context and Problem Statement

`--root` tells the tool what to index, and the default database location lived inside it. Both are
ordinary, low-friction defaults for the common case — but neither has a boundary: a misconfigured
`--root` (a host's `cwd`, a typo, a client pointed at the wrong directory) is walked exactly like a
correct one, and a database colocated with the indexed tree is one more path that same walk could
in principle reach. What should the tool refuse to do by default, regardless of how it was invoked?

## Decision Drivers

- A configuration mistake should fail loudly and immediately, not silently index (and expose
  through MCP tools) far more of the host than intended
- The database's default location should not depend on the indexed repository being well-behaved
  (gitignoring it, not colliding with it) to stay out of the walk
- None of this should require new configuration for the common case — every mechanism used here
  already existed for a different reason

## Considered Options

- Leave both as-is, relying entirely on the target repository's own `.gitignore` and the extraction
  engine's junk-directory defaults (`target/`, `node_modules/`, etc.)
- Add explicit boundaries: a fixed set of always-excluded paths, a refusal for unsafe roots, and a
  default database location outside whatever gets indexed

## Decision Outcome

Chosen option: **explicit boundaries**, three of them:

1. **Always-excluded paths.** `packages/engine-core/src/extractor.rs` now passes a fixed
   `extra_ignore_globs` list — `.ssh/`, `.aws/`, `.gnupg/`, `.config/`, `.kube/`, `.docker/`,
   `.npmrc`, `.netrc`, `.git-credentials`, `.env`, `.lci/` — into every walk. This composes with,
   rather than replaces, the repository's own `.gitignore` and the extraction engine's existing
   junk-directory defaults (`ignore_list.rs` in `lci-codegraph`); it does not depend on the target
   repository excluding these itself.
2. **A refusal for unsafe roots.** `packages/server/src/rootSafety.ts` flags a `--root` that
   resolves to the user's home directory or a filesystem root; `cli.ts` refuses to start at all when
   it does, before any configuration is even loaded. Credential paths are the risk the always-excluded
   list is aimed at specifically, but a home directory or filesystem root holds far more than that
   list could ever enumerate — this is a structural refusal rather than an attempt to keep growing
   the list to match.
3. **A database location outside the indexed tree by default.** `storage.database`'s default moves
   from `{{repoRoot}}/.lci/index.sqlite` to `{{dataDir}}/lci-mcp/{{repoKey}}/index.sqlite` —
   `{{dataDir}}`, a new template variable, resolves to `XDG_DATA_HOME` (or `~/.local/share`) on
   Linux, `~/Library/Application Support` on macOS, and `%LOCALAPPDATA%` on Windows. The database is
   no longer something the indexed repository's own `.gitignore` has to remember to exclude, and the
   always-excluded `.lci/` above remains as a second layer for anyone who configures a repository-
   local path back in directly (ADR-0008's templating still supports that).

A fourth, related boundary landed alongside these: `embedding.auth.apiKey` is refused when it
arrives via `--config-json`, since a command-line argument is visible to every other process on the
machine and to shell history — see `rejectInlineCredential` in
`packages/server/src/config/load.ts`. It shares this ADR's motivation (host secrets should not leak
through a path this tool controls) but isn't a boundary on indexing or storage, so it's recorded
here rather than given its own ADR.

### Consequences

- Good, because none of this needs new configuration to take effect — every existing user gets the
  protection automatically on upgrade
- Good, because the always-excluded list and the root refusal are independent layers: either one
  failing to anticipate a specific sensitive path is still caught by the other in the home/root case
- Bad, because the default database path changes on upgrade — an existing repository-local
  `.lci/index.sqlite` is not migrated, and the next run builds a fresh index at the new location
- Neutral, because `{{dataDir}}`-based paths are keyed by `repoKey`, not by filesystem path — two
  checkouts of the same remote now share one database by default, which was already an explicitly
  supported (if manual) layout under ADR-0008

## Pros and Cons of the Options

### Leave both as-is

- Good, because it needs no code changes at all
- Bad, because it depends on every target repository's own `.gitignore` being correct, and on the
  extraction engine's junk-directory defaults happening to cover credential paths they were never
  designed to cover

### Explicit boundaries

- Good, because the protection does not depend on anything about the repository being indexed
- Good, because each of the three boundaries is small and independently testable
- Bad, because the storage-path default change is a breaking change to where an existing
  installation's data lives

## More Information

See ADR-0008 for the templating mechanism this extends, and ADR-0007 for the configuration system
both live inside.
