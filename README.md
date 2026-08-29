# Lightbridge Code Intelligence — Local MCP

A local-first [Model Context Protocol](https://modelcontextprotocol.io) server that gives coding
agents repository-aware semantic and structural code retrieval: index a checkout once, then ask it
to find a symbol, walk callers/callees, explore a symbol's neighborhood, or search code by meaning.
No database server to install — everything is a single SQLite file next to the repository.

> **Status:** early — the core index → search → graph-query loop works end to end (see
> [`ARC42.md`](./ARC42.md) for the target architecture and [`docs/adr/`](./docs/adr) for the
> decisions made getting there), but packaging and release automation are not done yet.

## Quickstart

```bash
npx @vymalo/lightbridge-code-intelligence-mcp --stdio
```

Point an MCP host at that command and it exposes seven tools against the repository it's launched
in: `lci_index`, `lci_index_status`, `lci_search`, `lci_find_symbol`, `lci_get_callers`,
`lci_get_callees`, `lci_explore_symbol`.

Inspect the resolved configuration for the current repository without starting a server:

```bash
npx @vymalo/lightbridge-code-intelligence-mcp config show
```

### Configuration

Configuration is one object, mergeable from a config file, an `LCI_CONFIG_CONTENT` environment
variable, an inline `--config-json` flag, or CLI flags — see
[`docs/adr/0007-portable-configuration-object.md`](./docs/adr/0007-portable-configuration-object.md).
Semantic search needs an OpenAI-compatible embeddings endpoint:

```json
{
  "embedding": {
    "baseUrl": "https://your-embeddings-endpoint/v1",
    "model": "qwen3-embedding-8b",
    "dimensions": 4096,
    "auth": { "apiKey": "..." }
  }
}
```

Without `embedding.baseUrl` configured, indexing still builds the structural graph — `lci_find_symbol`,
`lci_get_callers`, `lci_get_callees`, and `lci_explore_symbol` all work; only `lci_search` needs
embeddings.

## Repository layout

```text
packages/
├── engine-core/   pure Rust: extraction orchestration, SQLite/sqlite-vec storage, graph + vector queries
├── engine/        thin napi-rs wrapper exposing engine-core as a native Node addon
└── server/        the MCP server and CLI (TypeScript)
docs/adr/          architecture decision records
```

`engine-core` has no N-API dependency at all, so it's testable with a plain `cargo test` —
including integration tests that index real open-source Rust and Java projects and check the
results against a committed golden graph (`packages/engine-core/tests/`). See
[`docs/adr/0005-separate-core-crate-from-napi-binding-crate.md`](./docs/adr/0005-separate-core-crate-from-napi-binding-crate.md)
for why the split exists.

## Development

Prerequisites: Node ≥ 18, [pnpm](https://pnpm.io), and a Rust toolchain.

```bash
pnpm install
pnpm build          # builds the native addon, then bundles the CLI
pnpm test           # server unit tests
pnpm test:e2e       # spawns the real built CLI and drives it over MCP stdio
pnpm typecheck
pnpm lint           # biome check .
```

Rust tests run independently of the above:

```bash
cd packages/engine-core && cargo test
```

To run the server against a real repository during development, without building first:

```bash
cd packages/engine && pnpm build   # native addon only needs rebuilding after Rust changes
cd packages/server && pnpm dev --root /path/to/some/repo --stdio
```

## Documentation

- [`ARC42.md`](./ARC42.md) — target architecture
- [`docs/adr/`](./docs/adr) — architecture decision records, one per significant decision
