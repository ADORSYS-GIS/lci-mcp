# ADR-0010: `packages/` monorepo layout and a single bundled CLI output

- **Status:** Accepted — Implemented
- **Date:** 2026-08-28
- **Deciders:** leghadjeu-christian

## Context and Problem Statement

The repository holds three buildable units: the pure-Rust extraction/storage core, a thin native
binding crate, and the TypeScript MCP server. How should these be laid out at the repository root,
and how should the TypeScript package be compiled into something runnable?

## Decision Drivers

- The layout should read as a small, deliberate set of packages, not an ad hoc collection of
  top-level directories
- A published CLI package should ship as a small number of clean files a user might actually open,
  not the raw output of a per-file compiler pass
- The build step should stay simple enough that a contributor never needs to reason about a bundler
  configuration to get productive

## Considered Options

- Top-level directories named directly after each unit (e.g. a directory per package, at the
  repository root)
- A `packages/` directory holding all three units, each a normal workspace member
- For the TypeScript build: per-file `tsc` compilation, versus bundling the CLI entry point into one
  file

## Decision Outcome

Chosen option: **a `packages/` directory** holding the core crate, the native binding crate, and the
TypeScript server, each a normal pnpm/Cargo workspace member; and **a bundler** (tsup, wrapping
esbuild) for the TypeScript CLI, producing one `dist/cli.js` with no scattered per-file
`.js`/`.d.ts`/`.js.map` output.

### Consequences

- Good, because the repository root reads as: a small number of top-level concerns (`packages/`,
  `docs/`), not a flat mix of package directories and project-level files
- Good, because the published package's `dist/` is a single small file — obviously complete at a
  glance, nothing to prune before publishing
- Bad, because a bundler is one more piece of build tooling in the dependency tree, versus relying
  on `tsc` alone
- Neutral, because the native binding crate still needs its own `napi build` step outside the
  bundler, since it produces a platform-specific `.node` file, not JavaScript

## Pros and Cons of the Options

### Top-level directories per unit

- Good, because paths are one directory level shallower
- Bad, because it reads as an unstructured collection rather than a deliberate workspace once there
  is more than a couple of units

### `packages/` directory

- Good, because it signals "this is a monorepo with N deliberate members" at a glance
- Bad, because every path gets one level deeper

### Per-file `tsc` compilation

- Good, because it needs no additional tool beyond the TypeScript compiler already used for
  type-checking
- Bad, because it scatters one `.js`, one `.d.ts`, and (if enabled) one `.js.map` per source file
  into `dist/`, for a CLI that has no library consumers needing those declaration files

### Bundled single-file output

- Good, because `dist/` stays small and obviously complete
- Bad, because stack traces point into bundled output unless source maps are re-enabled later

## More Information

None.
