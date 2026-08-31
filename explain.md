# lci-mcp — repository map

This file explains the repository itself: how it's laid out, how the pieces fit together, and where
to look next. Each package has its own `explain.md` going deeper into that package specifically —
this one stays at the "what lives where and why" level.

## What this is

A local-first [Model Context Protocol](https://modelcontextprotocol.io) server: index a repository
once into a local SQLite file, then answer structural (symbol/graph) and semantic (embedding)
retrieval questions about it over MCP stdio. No database server, no cloud dependency beyond an
optional embeddings endpoint.

## Layout

```text
Cargo.toml              root Cargo workspace — every third-party Rust crate version declared once
package.json             root pnpm workspace — build/test/lint scripts that fan out to each package
pnpm-workspace.yaml       pnpm workspace member list
tsconfig.base.json        shared TypeScript compiler options
biome.json                shared lint/format config
packages/
├── engine-core/          pure Rust — extraction, SQLite/sqlite-vec storage, graph + vector queries
│   ├── explain.md
│   └── migrations/         versioned SQL schema files, embedded into the compiled binary at build time
├── engine/               thin napi-rs wrapper — exposes engine-core as a native Node addon
│   └── explain.md
└── server/               the MCP server and CLI (TypeScript)
    └── explain.md
docs/
├── ARC42.md               target architecture
└── adr/                   architecture decision records, one per significant decision
.github/
├── workflows/              CI: engine.yml (Rust), server.yml (TypeScript)
├── ISSUE_TEMPLATE/         this org's issue forms
└── PULL_REQUEST_TEMPLATE.md
```

Three buildable units, two languages, one native boundary between them:

```text
packages/server  (TypeScript)
        │  imports as an ordinary npm dependency
        ▼
packages/engine  (Rust, compiled to a .node binary via napi-rs)
        │  plain Rust function calls
        ▼
packages/engine-core  (Rust, zero N-API dependency)
```

`engine-core` has no N-API dependency at all, which is why it's split out from `engine` in the first
place — a `#[napi]`-decorated crate emits module-registration hooks that only resolve inside a real
Node process, which breaks a plain `cargo test`. See
[ADR-0005](./docs/adr/0005-separate-core-crate-from-napi-binding-crate.md).

## Root Cargo workspace

```toml
# Cargo.toml
[workspace]
resolver = "3"
members = ["packages/engine-core", "packages/engine"]

[workspace.package]
edition = "2024"

[workspace.dependencies]
anyhow = "1"
thiserror = "2"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time"] }
rusqlite = { version = "0.40", features = ["bundled", "functions"] }
sqlite-vec = "0.1"
git2 = { version = "0.21", default-features = false, features = ["vendored-libgit2"] }
napi = { version = "3", default-features = false, features = ["napi4", "tokio_rt", "anyhow", "async"] }
# ...
```

Every third-party crate version is declared exactly once here; each member's own `Cargo.toml`
references it as `<crate>.workspace = true`. A version bump happens in one place, and one
`Cargo.lock` at the repo root covers both Rust crates.

## Root pnpm workspace

```json
{
  "scripts": {
    "build": "pnpm --filter @vymalo/lightbridge-code-intelligence-native build && pnpm --filter @vymalo/lightbridge-code-intelligence-mcp build",
    "build:engine": "pnpm --filter @vymalo/lightbridge-code-intelligence-native build",
    "build:server": "pnpm --filter @vymalo/lightbridge-code-intelligence-mcp build",
    "typecheck": "pnpm --filter @vymalo/lightbridge-code-intelligence-mcp typecheck",
    "test": "pnpm --filter @vymalo/lightbridge-code-intelligence-mcp test",
    "test:e2e": "pnpm --filter @vymalo/lightbridge-code-intelligence-mcp test:e2e",
    "lint": "biome check ."
  }
}
```

`build` runs the native addon first, then the server — order matters, since `packages/server`
imports the compiled `packages/engine` output directly (`export * from
"@vymalo/lightbridge-code-intelligence-native"` in `packages/server/src/engine.ts`). Running
`build:server` alone on a fresh checkout fails: there's nothing for that import to resolve against
yet.

## Getting from zero to a running server

```bash
pnpm install
pnpm build                                    # native addon, then the CLI bundle
node packages/server/dist/cli.js --stdio --root /path/to/some/repo
```

Rust tests run independently of the pnpm scripts, across the whole workspace:

```bash
cargo test --workspace
```

## Where to go next

- [`packages/engine-core/explain.md`](./packages/engine-core/explain.md) — the extraction/storage/query engine itself
- [`packages/engine/explain.md`](./packages/engine/explain.md) — the native Node addon boundary
- [`packages/server/explain.md`](./packages/server/explain.md) — the MCP tools, config, and embedding client
- [`docs/ARC42.md`](./docs/ARC42.md) — the target architecture in full
- [`docs/adr/`](./docs/adr) — why things are shaped the way they are, one decision at a time
