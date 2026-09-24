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
how many targets exist: Trusted Publishing categorically cannot create a package name, so the first
publish of any new package name is unavoidably a manual `npm publish` from a maintainer's machine
(`BOOTSTRAP_PUBLISH.md` has the exact, verified commands) — after that, CI publishes every future
version over OIDC with no further manual step, for that name, ever again.

`packages/engine/package.json`'s `files` field drops `*.node` — the root package now ships only the
generated JS/TS loader. `.github/workflows/publish.yml`'s build job scaffolds the platform
directories (`napi create-npm-dirs` + `napi artifacts` + `napi prepublish --skip-optional-publish
--no-gh-release`, the same three calls ADR-0011's predecessor used) and packs each one alongside the
two workspace packages. The publish job publishes every platform tarball in a loop that **attempts
every name and only fails at the end**, rather than aborting on the first failure — the exact shape
of the original failure ADR-0011 was written to avoid — then publishes the native and server
packages regardless of that loop's outcome, and finishes by polling the registry to confirm every
published name actually became installable (`npm publish` exiting 0 means accepted, not yet
necessarily visible).

Every `npm publish` call goes through a shared wrapper (`.github/scripts/npm-publish.sh`) instead of
being called directly, so a release can be re-run after a partial failure without a human first
working out which packages already landed: an already-published version is treated as success
rather than a hard error, and a short list of known-transient registry errors (network blips, a
5xx, an auth hiccup that clears on a fresh attempt) are retried with backoff.

Also drops the single-job, `zig`-cross-compiled build for the two Linux targets in favor of a
2-leg matrix (`ubuntu-latest`, `ubuntu-24.04-arm`) — each target now builds natively on the
architecture it targets, so the `zig`/`cargo-zigbuild` toolchain and its version pin are no longer
needed for these two targets at all.

Verified locally, for real: built both targets, ran the full scaffold → `CI=false` build → pack
sequence end to end, and confirmed the packed native package tarball is 6.7 KB against the two
platform tarballs carrying the ~40 MB binaries each. Separately, packed the already-published
native package and ran it through the publish wrapper in `--dry-run` mode, confirming `npm publish
--dry-run` does talk to the registry and returns the same "cannot publish over the previously
published version" error a real publish would, and that the wrapper correctly classifies it as
success.

### Consequences

- Good, because a typical install now downloads one platform's binary instead of every declared
  target's — the 30 MB-and-growing problem ADR-0011 accepted as a trade-off is gone
- Good, because a platform package publish failure no longer blocks the packages beside it or the
  release as a whole — the loop reports every failure and the native/server packages still publish
- Bad, because every *new* platform name (the macOS and Windows targets a follow-up change restores)
  needs a real, one-time `npm login`-based publish before CI can ever publish it — not automatable,
  and easy to forget when a new target is added
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

- Good, because it's the conventional, `@napi-rs/cli`-default layout
- Bad, because the bootstrap step is real manual work an engineer has to remember to do, once, for
  every new platform name

## More Information

- `BOOTSTRAP_PUBLISH.md` — the exact, verified commands for the one-time manual publish of each
  currently-declared platform package.
- [ADR-0011](./0011-multi-platform-native-package-publishing.md) — the decision this ADR partially
  supersedes for the two currently-declared Linux targets; its macOS/Windows-pausing reasoning is
  addressed separately.
- [npm/cli#8544](https://github.com/npm/cli/issues/8544) — Trusted Publishing cannot create a new
  package name.
