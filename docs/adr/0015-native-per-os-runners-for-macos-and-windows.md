# ADR-0015: Build macOS and Windows on native runners

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** @leghadjeu-christian
- **Supersedes:** ADR-0011's cross-compilation choice and its reasoning for pausing the macOS and
  Windows targets; [#14](https://github.com/ADORSYS-GIS/lci-mcp/issues/14)'s SDK-source decision is
  no longer needed

## Context and Problem Statement

ADR-0011 chose to cross-compile every target from one self-hosted Linux runner because that was the
only runner this org had. That constraint is gone — the repository is public, so GitHub-hosted
runners of every OS are free and unmetered (`CLAUDE.md`). ADR-0014 already drops the cross-compile
toolchain for the two Linux targets by building each natively on its own architecture instead.
Cross-compiling macOS and Windows from Linux hit two real, previously unresolved blockers under the
old constraint: `libgit2-sys` links `Security.framework`/`CoreFoundation.framework` unconditionally
for any Apple target, and `zig cc` has no real Apple SDK to resolve them against (tracked in #14,
which was waiting on a decision about sourcing a third-party SDK bundle); `cargo-xwin` drives the
MSVC toolchain through LLVM binutils the GitHub-hosted Ubuntu image doesn't ship. Given real per-OS
runners are now free, does either blocker still need solving?

## Decision Drivers

- Every C dependency (`rusqlite`'s bundled SQLite, `git2`'s vendored libgit2, `ring`) should build
  against the toolchain it was actually written for, not an emulation of it
- No third-party SDK bundle should need sourcing or trusting, if it can be avoided entirely
- The build should stay verifiable in CI without new infrastructure to provision or maintain

## Considered Options

- Solve the cross-compile blockers directly: source a macOS SDK bundle for zig (the decision #14 was
  waiting on) and get `cargo-xwin`'s MSVC toolchain working on the Ubuntu runner
- Build every target on a real runner for that OS instead of cross-compiling any of them

## Decision Outcome

Chosen option: **real per-OS runners**. `.github/workflows/publish.yml`'s build matrix (already
2-way for the Linux targets since ADR-0014) grows to five legs — `ubuntu-latest`, `ubuntu-24.04-arm`,
`macos-15-intel` (x86_64 macOS), `macos-latest` (arm64 macOS, GitHub's default fleet),
`windows-latest` — each building only its own target, natively. This dissolves both blockers as a
side effect rather than solving them directly: a real macOS runner has Xcode's SDK pre-installed, so
`Security.framework`/`CoreFoundation.framework` simply exist — no `SDKROOT`, no third-party bundle,
no decision to make; a real Windows runner has the actual MSVC toolchain already on `PATH`, so
`cargo-xwin`, `clang-cl`, and `llvm-lib` are no longer needed at all — the crate builds with the same
`cc`/`link.exe` any native Windows Rust project uses.

`packages/engine/package.json`'s `napi.targets` grows back to five entries.

**What this could not verify:** the actual C-dependency builds on macOS and Windows. This sandbox has
no macOS or Windows toolchain, so the strongest local check available was `cargo check --target
<target>`, which fails identically on all three new targets — not on a source-level incompatibility
(a grep of `packages/engine/src` and `packages/engine-core/src` for `cfg(windows)` / `cfg(unix)` /
`cfg(target_os` found nothing — neither crate has any platform-conditional code at all), but because
`cc-rs` invokes this machine's Linux `cc`/absent `lib.exe` regardless of `--target`, the same way it
would fail before ever reaching a real macOS or Windows toolchain. Confirming the C dependencies
actually build (`ring`, `libz-sys`, `libgit2-sys`, bundled SQLite) needs a real CI run against real
runners — this is what the `workflow_dispatch` `rehearsal` input (ADR-0014) exists to make possible
without risking a real npm publish first.

### Consequences

- Good, because both previously-blocking issues (#14's SDK sourcing, Windows' missing MSVC binutils)
  are resolved as a side effect of the runner choice, not as separate work
- Good, because every C dependency builds against its real, native toolchain — categorically less
  cross-compile-specific risk than ADR-0011 accepted
- Bad, because the build job now runs 5 parallel jobs instead of 1 sequential one, and macOS/Windows
  runner minutes, while free for this public repo today, are a cost this design now depends on
  staying free
- Neutral, because this PR's macOS/Windows legs are verified by design, not by a local build in this
  environment — the `rehearsal` input exists to close that gap with a real, safe CI run before the
  first real tag

## Pros and Cons of the Options

### Solve the cross-compile blockers directly

- Good, because it keeps everything on one runner type
- Bad, because it requires sourcing and trusting a third-party macOS SDK bundle (the exact decision
  #14 was left waiting on), and still needs the Windows MSVC-binutils problem solved separately

### Real per-OS runners

- Good, because it needs no new infrastructure — GitHub already provides all three OS types free for
  a public repo
- Bad, because it depends on that free-runner-minutes policy continuing to apply

## More Information

- [ADR-0011](./0011-multi-platform-native-package-publishing.md) — the cross-compilation decision
  this ADR supersedes.
- [ADR-0014](./0014-restore-per-platform-native-packages.md) — drops the cross-compile toolchain for
  the two Linux targets; this ADR extends the same matrix to macOS and Windows.
- [#14](https://github.com/ADORSYS-GIS/lci-mcp/issues/14) — the SDK-source decision this makes moot.
