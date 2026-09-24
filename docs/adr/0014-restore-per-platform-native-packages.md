# ADR-0014: Restore per-platform native packages instead of bundling every binary

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** @leghadjeu-christian
- **Supersedes:** ADR-0011's decision to ship every target's `.node` binary inside the one
  `@vymalo/lightbridge-code-intelligence-native` package

## Context and Problem Statement

ADR-0011 chose to bundle every declared target's `.node` binary inside the one native package
after the original per-platform-package layout (`optionalDependencies`, one `os`/`cpu`-scoped
package per target — the layout `@napi-rs/cli` defaults to) failed in production: npm's OIDC
Trusted Publishing can only publish to a package name that already exists
([npm/cli#8544](https://github.com/npm/cli/issues/8544)), and none of the per-platform names had
ever been published, so the release died 404-ing on the first one. Bundling worked around that at
a real cost, recorded in ADR-0011 itself: every install downloads every target's binary — 11 MB
packed, 30 MB unpacked for just the two Linux targets that exist today, growing linearly as macOS
and Windows targets return. How do we get back to per-platform packages without hitting the same
publish failure?

## Decision Drivers

- Every install should download only its own platform's binary, not every declared target's
- The fix must not depend on OIDC Trusted Publishing doing something it categorically cannot do
  (create a new package name)
- A missing or failed platform package should not take the whole release down

## Considered Options

- Keep bundling every binary in the one package (status quo since ADR-0011)
- Restore the per-platform-package layout, with each new platform name bootstrapped by a one-time
  manual `npm publish` before its Trusted Publisher is configured

## Decision Outcome

Chosen option: **restore the per-platform-package layout**, with the manual bootstrap step ADR-0011
treated as a blocker. It isn't one — it's a fixed, one-time cost per platform name, independent of
how many targets exist, confirmed by studying how `cratestack/cratestack` runs the identical
pattern in production for its own napi-rs addon (`@cratestack/cbor-node`, 7 platform packages) —
see `PUBLISHING_REPORT.md` for the full comparison. Their own docs are explicit: "Trusted Publishing
categorically cannot create a package name, so the first publish of any new package is unavoidably
a manual `npm publish` from a maintainer's machine" — after that, CI publishes every future version
over OIDC with no further manual step, for that name, ever again.

`packages/engine/package.json`'s `files` field drops `*.node` — the root package now ships only the
generated JS/TS loader. `.github/workflows/publish.yml`'s build job scaffolds the platform
directories (`napi create-npm-dirs` + `napi artifacts` + `napi prepublish --skip-optional-publish
--no-gh-release`, the same three calls ADR-0011's predecessor used) and packs each one alongside the
two workspace packages. The publish job publishes every platform tarball in a loop that **attempts
every name and only fails at the end**, rather than aborting on the first failure — the exact shape
of the original failure ADR-0011 was written to avoid, borrowed from cratestack's own fix for the
same incident in their release pipeline (`cratestack#850`) — then publishes the native and server
packages regardless of that loop's outcome, and finishes by polling the registry to confirm every
published name actually became installable (`npm publish` exiting 0 means accepted, not yet
necessarily visible).

Verified locally before landing: built both currently-declared targets, ran the full scaffold →
`CI=false` build → pack sequence end to end, and confirmed the packed native package tarball is 6.7
KB against the two platform tarballs carrying the ~40 MB binaries each — see this PR's description
for the exact commands and output.

### Consequences

- Good, because a typical install now downloads one platform's binary instead of every declared
  target's — the 30 MB-and-growing problem ADR-0011 accepted as a trade-off is gone
- Good, because a platform package publish failure no longer blocks the packages beside it or the
  release as a whole — the loop reports every failure and the native/server packages still publish
- Bad, because every *new* platform name (the macOS and Windows targets once they return, tracked in
  [#14](https://github.com/ADORSYS-GIS/lci-mcp/issues/14) and this ADR's own predecessor) needs a
  real, one-time `npm login`-based publish before CI can ever publish it — not automatable, and easy
  to forget when a new target is added
- Neutral, because the `CI=false` override this reintroduces (first added in PR #18, removed by
  ADR-0011's PR #21 alongside the scaffolding it existed to work around) is back for the same reason
  it existed before: `packages/engine/package.json`'s `optionalDependencies` name a version that
  isn't on the registry yet mid-release, and `pnpm`'s default `CI=true` strict-lockfile behavior
  refuses to install around that

## Pros and Cons of the Options

### Keep bundling every binary

- Good, because it needs no bootstrap step, ever
- Bad, because install size grows with every target added, forever, for every consumer regardless of
  platform

### Restore per-platform packages, with a one-time manual bootstrap

- Good, because it's the conventional, `@napi-rs/cli`-default layout, proven at 7 targets by
  cratestack's own production pipeline
- Bad, because the bootstrap step is real manual work an engineer has to remember to do, once, for
  every new platform name

## More Information

- `PUBLISHING_REPORT.md` — the full study of cratestack's implementation this decision is based on,
  including the parts of their approach deliberately *not* adopted (they keep bundling every binary
  in their root package too, as a reliability fallback on top of the per-platform packages — a
  trade-off that doesn't serve this project's actual goal of smaller installs).
- `BOOTSTRAP_PUBLISH.md` — the exact, verified commands for the one-time manual publish of each
  currently-declared platform package.
- [ADR-0011](./0011-multi-platform-native-package-publishing.md) — the decision this ADR partially
  supersedes; its cross-compilation choice and target-pausing reasoning (macOS SDK, Windows
  toolchain) are unaffected by this change.
- [npm/cli#8544](https://github.com/npm/cli/issues/8544) — Trusted Publishing cannot create a new
  package name.
