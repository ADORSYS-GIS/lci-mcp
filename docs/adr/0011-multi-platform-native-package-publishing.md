# ADR-0011: Publish native binaries for every declared target from one runner

- **Status:** Proposed
- **Date:** 2026-09-03
- **Deciders:** @leghadjeu-christian

## Context and Problem Statement

`packages/engine/package.json` declares five `napi.targets` (Linux x64/arm64 gnu, macOS x64/arm64,
Windows x64), but `napi build --platform --release` only produces the binary for whatever machine
runs it, and there is no pipeline that builds the other four. The org has one self-hosted Linux
runner and GitHub-hosted runner minutes are billing-blocked, so a build matrix of native per-OS
runners isn't available. How does a single Linux runner produce installable binaries for macOS and
Windows too?

## Decision Drivers

- Installing the published package on any of the five declared platforms must resolve a real `.node`
  binary, not fail with `MODULE_NOT_FOUND`
- No GitHub-hosted runners, and only one self-hosted (Linux x64) runner exists
- A missing target should fail the release build loudly, not surface later as someone else's install
  error

## Considered Options

- A native per-OS runner matrix (one job per target, each on its own OS)
- Cross-compilation from the single Linux runner via `napi build --cross-compile`, publishing
  per-platform variant packages as `optionalDependencies`

## Decision Outcome

Chosen option: **cross-compilation from the single runner**. `@napi-rs/cli`'s `--cross-compile` flag
builds every non-host target from one machine — `cargo-zigbuild` for macOS/Linux-arm64, `cargo-xwin`
for Windows-MSVC — which fits the runner constraint without provisioning new infrastructure.
Every target's binary then ships inside the one `@vymalo/lightbridge-code-intelligence-native`
package: the build loop writes each `.node` into `packages/engine/`, that package's `files` glob
picks them all up, and the generated loader in `packages/engine/index.js` resolves the host
platform's binary from the package it was installed from — its per-platform `require` of a bundled
`./lci-mcp-engine.<target>.node` is tried before the `optionalDependencies` fallback, so the loader
needed no change. A smoke test (`packages/server/scripts/smoke-test-native.mjs`) runs in the same job
right after the build loop, asserting the binding actually loads before anything gets published.

Distributing one `os`/`cpu`-scoped package per target instead — `napi create-npm-dirs` +
`napi pre-publish` scaffolding them under `packages/engine/npm/` and wiring them into
`optionalDependencies` — is the layout `@napi-rs/cli` defaults to, and remains the right answer once
the target matrix is large enough that shipping every binary to every install stops being
proportionate. It is not viable while the matrix is small: npm configures trusted publishing per
package and only for packages that already exist ([npm/cli#8544](https://github.com/npm/cli/issues/8544)),
so each new per-target package name has to be bootstrapped by a token publish before OIDC can ever
publish it.

### Consequences

- Good, because no new runner infrastructure is needed — a single GitHub-hosted Linux runner covers
  every declared target
- Good, because the release publishes only package names that already exist, so it never depends on
  a bootstrap step that OIDC trusted publishing cannot perform
- Bad, because every install downloads every target's binary — 11 MB packed and 30 MB unpacked for
  the two Linux targets, of which one is always dead weight
- Bad, because cross-compiling C dependencies (`rusqlite`'s bundled SQLite, `git2`'s vendored
  libgit2) under `zig cc`/`cargo-xwin` hasn't been fully verified against this crate's actual
  dependency set yet — see [#5](https://github.com/ADORSYS-GIS/lci-mcp/issues/5). Only the two Linux
  targets are declared in `napi.targets` today:
  - the macOS targets are paused because `libgit2-sys`'s build script links
    `Security.framework`/`CoreFoundation.framework` unconditionally for any Apple target, and
    `zig cc` cannot resolve real Apple frameworks without an actual macOS SDK on `SDKROOT` — see
    [#14](https://github.com/ADORSYS-GIS/lci-mcp/issues/14) for the SDK-source decision and the work
    to restore them
  - the Windows target is paused because `cargo-xwin` drives the MSVC toolchain through LLVM's
    binutils (`CC=clang-cl`, `AR=llvm-lib`), and the GitHub-hosted Ubuntu image ships the Clang
    front-end without them, so every C-bearing dependency fails to archive
- Neutral, because publishing needs its own auth mechanism decided separately — see
  [ADR-0013](./0013-oidc-trusted-publishing.md), which replaces the `NPM_TOKEN` this note originally
  anticipated with OIDC trusted publishing instead

## Pros and Cons of the Options

### Native per-OS runner matrix

- Good, because it's the most conventional approach with the fewest cross-compilation unknowns
- Bad, because it needs macOS/Windows runners that don't currently exist for this org, and
  GitHub-hosted runners are unavailable

### Cross-compilation from one runner

- Good, because it works entirely within the existing infrastructure
- Bad, because cross-compiled C-dependency builds carry more risk of subtle target-specific failures
  than building natively on each OS

## More Information

- [#5](https://github.com/ADORSYS-GIS/lci-mcp/issues/5) — tracks verifying each target actually
  builds and installs correctly; this ADR records the chosen mechanism, not a confirmation it has
  been proven end to end yet.
- [napi-rs cross-compilation reference](https://napi.rs/docs/deep-dive/release)
