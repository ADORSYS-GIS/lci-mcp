# Implementation Plan — `@vymalo/lightbridge-code-intelligence-mcp`

> Companion to [ARC42.md](./ARC42.md). ARC42.md is the target architecture; this document is the
> build plan that gets there — phased workstreams, concrete schemas, module layout, and the open
> decisions that must be closed before (or during) each phase. Repository status at the time of
> writing: **greenfield** — only `ARC42.md` and a stub `README.md` exist, no code, no `package.json`,
> no Cargo workspace.

Sources consulted to ground this plan (not just the spec): `lci-codegraph` source (`src/lib.rs`,
`src/walk.rs`, `src/input.rs`, `src/graph/*`, `src/embed/*`, `src/chunk.rs`, `crates/lci-codegraph-model`,
`docs/architecture.md`, `explained/*.md`) at `/home/christian/ai/lci-codegraph`, and
`lightbridge-code-intelligence`'s `services/control-plane/src/integrations/neo4j.rs`,
`services/agent-clients/src/embeddings.rs`, `services/control-plane/src/mcp/*`, `clients/lci/src/config.rs`
+ `auth/*`, `docs/indexing-and-storage.md`, `docs/components-and-data-models.md`, and
`docs/rfc/0002-incremental-layered-indexing.md` at `/home/christian/ai/lightbridge-code-intelligence`.

---

## 1. Critical open decisions (resolve before/at Phase 1)

These aren't implementation details — each one changes the shape of downstream code, so they're
called out before any phase plan. Where a decision doesn't have an owner yet, this plan takes a
default position and flags it as `DEFAULT:` so work can proceed without blocking on sign-off.

### 1.1 The `embed_input` seam — the single biggest architectural gap in ARC42 as written

`lci-codegraph` (the version at `/home/christian/ai/lci-codegraph`, i.e. *newer* than the pinned
`rev` lightbridge-code-intelligence currently depends on) already ships a full embeddings pipeline
in `src/embed/`:

- `embed::context::embed_input()` builds the graph-aware header (`// file:`, `// within:`,
  `// calls:`, `// called by:`) — the single feature that makes this crate's chunks meaningfully
  better than raw-text chunks for retrieval.
- `embed::client` makes the actual blocking `ureq` HTTP call to `POST /embeddings`.
- `embed::embed_chunks(chunks, graph, config, batch_size)` does **both in one function**: it is not
  possible today to get `Chunk::embed_input` populated without also triggering the network call in
  the same call, because `EmbedConfig` only supports a static `api_key`, and the network call
  happens inside the same loop that sets `embed_input`.

ARC42 §2.1 and ADR-LCI-MCP-003 are explicit that embedding HTTP, auth-helper-driven dynamic headers,
retries, and enterprise auth must live in **TypeScript**, not Rust. `EmbedConfig` cannot express
auth-helper-issued headers (it has no headers map, only `api_key: Option<String>`) and running the
whole `embed_chunks` from native code would silently violate ADR-LCI-MCP-004 (generic auth helper).

**Resolution — required upstream change to `lci-codegraph`:**

Split `embed::embed_chunks` into two independently-usable pieces (this is a small, additive,
backward-compatible change to `lci-codegraph`, not a fork):

```rust
// New, network-free. Builds ContextIndex once and sets chunk.embed_input on every chunk.
pub fn prepare_embed_inputs(chunks: &mut [Chunk], graph: &Graph, config: &EmbedContextConfig);

// Existing embed_chunks becomes a thin wrapper: prepare_embed_inputs + the existing batch/HTTP loop.
```

`EmbedContextConfig` is the subset of today's `EmbedConfig` that only affects header shape
(`max_context_refs`, `max_input_chars`) — no `base_url`/`api_key`/`model`/`timeout`/`max_retries`.

**Action item:** file this as an upstream issue/PR against `lci-codegraph` in Phase 1 (§3.1, task
N-1). Until it lands, lci-mcp's native addon calls `prepare_embed_inputs` from a vendored/patched
copy (git branch/patch dependency) rather than reimplementing the context-header logic — reimplementing
it would fork extraction semantics, which ARC42 §5.3 (`CodeGraphExtractor`) explicitly forbids
("must not fork a separate extraction semantics for local MCP").

**DEFAULT until upstream lands:** depend on `lci-codegraph` via a git dependency pinned to a fork
branch carrying only this split (mirroring how `lightbridge-code-intelligence` itself pins
`lci-codegraph` by exact `rev` in `services/agent-runner/Cargo.toml`), then flip to the published
crate once the split is upstreamed.

### 1.2 Repository naming: `ADORSYS-GIS/lci-codegraph` vs. `vymalo/lci-codegraph`

ARC42.md's header and Appendix D cite `ADORSYS-GIS/lci-codegraph` and
`ADORSYS-GIS/lightbridge-code-intelligence`. The actual `Cargo.toml` in `lci-codegraph` declares
`repository = "https://github.com/vymalo/lci-codegraph"`, and `lightbridge-code-intelligence` itself
pins its git dependency at `vymalo/lci-codegraph`. **Action item:** confirm which org is canonical
(fork vs. rename vs. stale doc) before publishing ARC42.md's Appendix D links or wiring CI to a repo
URL — low risk, but worth five minutes before `Cargo.toml`/`package.json` `repository` fields are
written in Phase 0.

### 1.3 `lci_index` synchronous vs. async return (ARC42 §6.2 flags this explicitly)

**DEFAULT:** `lci_index` returns immediately after the indexing lease is acquired and the generation
enters `BUILDING`, with a `generationId`; progress/completion is observed via `lci_index_status`.
Rationale: full-repo indexing on a large monorepo can run minutes, and MCP stdio calls from most
hosts (OpenCode, Claude Code) have client-side timeouts shorter than that. A synchronous option can
be added later as `lci_index({ wait: true })` implemented as poll-until-done sugar around the same
async primitive — cheap to add later, expensive to remove if built the other way first.

### 1.4 `repoKey` canonicalization algorithm (ARC42 §8.5, §11.6)

**DEFAULT algorithm** (must be locked and tested before any V1 release, since changing it silently
relocates every user's default DB path):

```text
1. resolve `git rev-parse --show-toplevel` (fails → use canonicalized absolute filesystem root as fallback identity, tagged "no-remote")
2. if a `remote.origin.url` exists: normalize to `{host}/{owner}/{repo}` lowercase,
   stripping `.git` suffix and translating `git@host:owner/repo` <-> `https://host/owner/repo` to the same string
3. identity_input = remote-normalized-form if present, else `no-remote:{canonical_root_realpath}`
4. repoKey = first 16 hex chars of BLAKE3(identity_input)   -- BLAKE3 chosen for speed + native npm binding availability; SHA-256 is an acceptable fallback if a dependency-count concern rules BLAKE3 out
```

Two clones of the same remote get the *same* `repoKey` (correct: they should share one cache entry
under `{{tmpDir}}` templating, and this is explicitly desired per ARC42 §8.4's shared-cache example).
Two Git worktrees of the same repo also get the same `repoKey` today under this algorithm — call this
out explicitly in `config show` output and docs rather than silently surprising a worktree user; a
worktree-aware variant (folding in `git rev-parse --git-common-dir`) is a candidate refinement but
adds complexity (`repoKey` would then differ from a plain clone of the same remote) — leave for a
later release unless a real worktree bug report drives it.

### 1.5 Engine persistence stack

**DEFAULT:** `rusqlite` (`bundled` feature — compiles SQLite from source, which is what makes clean
cross-compilation onto every napi-rs target tractable without relying on a system `libsqlite3`) +
the `sqlite-vec` Rust crate, registered via `rusqlite`'s extension-loading hook
(`sqlite_vec::sqlite3_vec_init` wired through `ffi::sqlite3_auto_extension` at connection-open time,
per `sqlite-vec`'s documented Rust integration path) rather than `dlopen`-ing a `.so`/`.dll` at
runtime — this keeps the native `.node` addon self-contained with zero runtime file dependencies,
consistent with ARC42 §2.1 ("linked into the native addon rather than loaded through an additional
dependency").

---

## 2. Repository layout

Two hand-authored components, not a large multi-package monorepo — so they sit at the repository
root as `server/` and `engine/` rather than behind an extra `packages/` umbrella that would only be
justified by having many members. `engine` is named for what it actually contains (repository
inspection, index/generation coordination, extraction orchestration, SQLite + graph + vector storage
and query services) rather than for its implementation mechanism (a native N-API addon is *how* it's
delivered to Node, not *what* it is) — "native" on its own said nothing about the code-intelligence
work happening inside it.

```text
lci-mcp/                                 (this repo — pnpm workspace + Cargo workspace side by side)
├── ARC42.md
├── IMPLEMENTATION_PLAN.md               (this file)
├── README.md
├── package.json                         (workspace root, private)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json  (or eslint+prettier — pick one, match lightbridge-code-intelligence's biome.json for org consistency)
│
├── server/                              → published as @vymalo/lightbridge-code-intelligence-mcp
│   ├── package.json
│   └── src/
│       ├── cli.ts                       entry point, arg parsing (yargs/citty), dispatch --stdio | config show
│       ├── config/
│       │   ├── schema.ts                zod schema = the public JSON Schema source of truth
│       │   ├── load.ts                  precedence chain (§6 below)
│       │   ├── template.ts              {{repoRoot}} etc. expansion
│       │   └── repoKey.ts               §1.4 algorithm (mirrors engine/src/repository.rs — see note there)
│       ├── mcp/
│       │   ├── server.ts                @modelcontextprotocol/sdk wiring, stdio transport
│       │   └── tools/
│       │       ├── index.ts             lci_index
│       │       ├── indexStatus.ts       lci_index_status
│       │       ├── search.ts            lci_search
│       │       ├── findSymbol.ts        lci_find_symbol
│       │       ├── callers.ts           lci_get_callers
│       │       ├── callees.ts           lci_get_callees
│       │       └── exploreSymbol.ts     lci_explore_symbol
│       ├── embedding/
│       │   ├── client.ts                OpenAI-compatible client (§7 below)
│       │   └── retry.ts
│       ├── auth/
│       │   ├── helper.ts                spawn + capture + parse (§8 below)
│       │   └── cache.ts                 atomic 0600 header cache
│       ├── logging.ts                   stderr-only pino/consola instance
│       └── engine.ts                    thin typed re-export of the compiled engine's TS surface
│
├── engine/                              → the code-intelligence engine: napi-rs crate, publishes as
│   │                                      @vymalo/lightbridge-code-intelligence-native(-<platform>)
│   │                                      per ARC42 §2.2's public npm contract — only the *directory*
│   │                                      is renamed here, not the published package name
│   ├── Cargo.toml                       depends on `lci-mcp-engine-core` (path = "../engine-core")
│   ├── package.json                     napi-rs codegen target
│   ├── build.rs
│   ├── index.d.ts                       generated by napi-rs — do not hand-edit
│   ├── npm/                             per-platform packages, generated by napi-rs tooling (§Phase 7)
│   └── src/
│       ├── lib.rs                       CodeIndex napi class — thin: DTO conversion + spawn_blocking plumbing only
│       └── dto.rs                       #[napi(object)] mirrors of engine-core's dto.rs, with From conversions
│
├── engine-core/                         → pure Rust, zero napi dependency (see §1.1a below for why)
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs
│   │   ├── dto.rs                       plain data types shared by store/index_coordinator
│   │   ├── repository.rs                RepositoryInspector
│   │   ├── index_coordinator.rs         IndexCoordinator (generations, lease)
│   │   ├── extractor.rs                 thin lci-codegraph wrapper (CodeGraphExtractor)
│   │   ├── store/
│   │   │   ├── mod.rs                   SqliteStore
│   │   │   ├── schema.rs                DDL + migrations (§4.2)
│   │   │   ├── chunks.rs
│   │   │   ├── graph.rs                 GraphQueryService (§5 below)
│   │   │   └── vectors.rs               SemanticSearchService, sqlite-vec glue
│   │   └── lease.rs                     IndexLock
│   └── tests/
│       ├── real_repos.rs                real-world Rust/Java integration tests (§9)
│       └── fixtures/                    real source copied from lci-codegraph's own examples/apps
│
├── docs/
│   └── adr/                             ADR-LCI-MCP-00N.md, one file per ARC42 §9 decision (split out of ARC42.md as they're made, not required day one)
│
└── e2e/
    └── ...                              MCP-protocol-level tests (§9.4)
```

Two workspaces (`pnpm-workspace.yaml` for TS, plain path-dependency Cargo crates — not a Cargo
`[workspace]`, since `engine/` must stay a normal standalone package for napi-rs's own tooling
(`napi build`) to operate on directly from that directory) rather than one polyglot tool. This also
keeps `server` a pure-TS package that only ever depends on the *published* engine package
(`optionalDependencies` on platform packages), never on Cargo — so a contributor working purely on
MCP tool shape never needs a Rust toolchain.

### 1.1a Why `engine-core` exists as a separate crate (found during implementation, not planned upfront)

The original plan (and this file's own §4, still describing the design accurately at the schema/query
level) assumed one `engine/` crate holding both the `#[napi]`-decorated `CodeIndex` class and all the
actual store/graph/extraction logic. That does not work: a crate with *any* `#[napi]`-decorated item
emits an unconditional module-registration hook that references real N-API C symbols (`napi_typeof`,
`napi_create_object`, …) — symbols that only ever resolve inside an actual Node process `dlopen`-ing
the compiled `.node` file. A plain `cargo test` integration-test binary linking against such a crate
fails at link time (`undefined symbol: napi_create_array_with_length`, and dozens more) *regardless*
of whether the test only touches plain, non-napi-decorated modules — module-privacy structuring alone
cannot fix this, because the poisoning happens at the whole-crate level via that registration hook,
not per-item.

The fix — and the standard pattern real napi-rs projects use for exactly this reason — is what's
reflected in the tree above: `engine-core` holds 100% of the logic with zero napi dependency (fully
testable with ordinary `cargo test`, including real-world integration tests with no Node runtime
involved at all), and `engine` becomes a thin wrapper: its own `dto.rs` mirrors `engine-core::dto`'s
plain types as `#[napi(object)]` structs with mechanical `From` conversions, and `lib.rs`'s `CodeIndex`
methods do nothing but convert + call straight through. This is a strictly better architecture than
the original single-crate plan, not a compromise — keep it.

---

## 3. Phased roadmap

Each phase has a concrete exit criterion. Phases 1–4 can mostly proceed in parallel across a
native-Rust track and a TypeScript track once the N-API surface (§4.4) is stubbed in Phase 0.

### Phase 0 — Scaffolding (native surface frozen, everything else stubbed)

- `engine/`: napi-rs project (`napi new`), `Cargo.toml` with the dependency set from §4.1,
  empty `CodeIndex` class exposing every method signature from ARC42 §5.4 as `todo!()`/`unimplemented!()`
  stubs — the point is to freeze the N-API *shape* (async, error types, parameter/return DTOs) early
  so TS code in later phases isn't blocked on Rust internals.
- `server/`: `--stdio` boots an MCP server that registers all seven tools from Appendix A with
  correct Zod input schemas and hand-written placeholder outputs (no native calls yet). This proves
  the MCP protocol surface against a real host (Claude Code / OpenCode) before any indexing logic
  exists — cheap to validate the tool *names, descriptions, and schemas* are ergonomic for a model to
  call correctly, which is easier to iterate on before it's wired to real (slow) native calls.
- CI: lint + typecheck (TS) + `cargo check` (native) on every push. No release automation yet.
- **Exit:** `npx --stdio` (run from a local `npm link`) round-trips a `tools/list` call against a
  real MCP client and shows all seven tools with valid JSON Schemas.

### Phase 1 — Engine core: extraction → SQLite, no embeddings, no MCP

- File the `lci-codegraph` upstream split (§1.1) — or stand up the fork-branch dependency if upstream
  turnaround will block this phase.
- `RepositoryInspector`: canonical root, HEAD SHA, dirty-state detection (`git status --porcelain`
  via `git2` or shelling to `git`; **DEFAULT: `git2` crate** — avoids parsing `git` CLI output and
  matches the "no implicit shell" security posture ARC42 §8.14 asks for elsewhere), `repoKey` (§1.4).
- `SqliteStore`: schema (§4.2) + migrations; `schema_metadata` versioning from day one even though
  there's only one version yet (ARC42 §8.10 — must not be retrofitted).
- `CodeGraphExtractor`: calls `lci_codegraph::walk_checkout` with `build_graph: true`, no `embed`
  config, persists `chunks`/`graph_nodes`/`graph_edges` into a `BUILDING` generation. Correlate each
  `Chunk` to its `GraphNode` at write time by `(file_path, chunk.start_line + 1)` lookup against the
  just-persisted `graph_nodes` for this generation — **this exact `+1` offset must be replicated**
  from `lci-codegraph`'s own `ContextIndex::map_chunk` (0-based chunk lines vs. 1-based graph node
  lines); store the result as `chunks.node_id` (nullable — window/PDF chunks have no graph node).
- `IndexCoordinator`: `beginIndex`/`commitIndex`/`failIndex` against the generation state machine
  (ARC42 §6.3), but with `nextEmbeddingBatch`/`putEmbeddings` as no-ops returning empty (Phase 3
  wires these for real) — a generation can reach `ACTIVE` with `chunk_vectors` empty, which is fine
  for structural-only search-less operation while this phase is landing.
- Determinism test mirroring `lci-codegraph`'s own philosophy: walking the same fixture repo twice
  produces byte-identical `graph_nodes`/`graph_edges` rows (sorted) — catches an accidental
  nondeterminism introduced at the SQLite-write boundary, not just inside `lci-codegraph` itself.
- **Exit:** `CodeIndex.open()` → `beginIndex()` → `commitIndex()` against a real small repo populates
  `chunks`, `graph_nodes`, `graph_edges` correctly, verified against `lci-codegraph`'s own golden
  fixture (`tests/fixtures/sample-repo` — reuse it as a submodule or copied fixture, not
  reinvented) for the exact node/edge counts `lci-codegraph`'s own `tests/parity.rs` already asserts.

### Phase 2 — Graph query service (structural retrieval, still no embeddings)

- Implement `find_symbol`, `get_callers`, `get_callees` as plain indexed SQL, directly translating
  the production Cypher in `lightbridge-code-intelligence`'s
  `services/control-plane/src/integrations/neo4j.rs` (§5 below has the exact queries).
- Implement `explore_symbol`'s bounded neighborhood traversal as a `WITH RECURSIVE` CTE (§5.3) —
  this is the one query with no single-hop precedent in the existing SQL-shaped queries above, so it
  gets its own test file with cycle fixtures (a→b→a) proving termination and dedup.
- Hard caps (ARC42 §8.12): depth clamp (1..=3, mirroring the Cypher `graph_neighborhood`'s existing
  clamp), result-row LIMIT enforced server-side regardless of client-requested value.
- `graph_nodes`/`graph_edges` indexes: `(generation_id, source, relation)`,
  `(generation_id, target, relation)`, `(generation_id, node_id)` — verify with `EXPLAIN QUERY PLAN`
  that every query in this phase hits an index, not a table scan, before moving on.
- **Exit:** `CodeIndex.findSymbol/.callers/.callees/.exploreSymbol` return correct results against
  the same fixture repo's known call graph (reuse the exact assertions from
  `lci-codegraph/tests/container_neo4j.rs` — e.g. `add()`'s one caller is `main()`, `Square::new`
  has zero callers — as a direct regression suite, since those facts don't change once the fixture
  doesn't).

### Phase 3 — Embedding pipeline (TS embedding client, native batch handoff, sqlite-vec)

- TS `embedding-client` package modeled directly on `lightbridge-code-intelligence`'s
  `services/agent-clients/src/embeddings.rs` (§7 below): batch POST, response reordered by the
  response's `index` field (never trust array position), retry only on connect/timeout/429/5xx with
  exponential backoff + `Retry-After` honoring, immediate failure on other 4xx, error bodies never
  include the request payload in logs.
- Engine: `nextEmbeddingBatch(generationId, limit)` reads chunks with `embed_input IS NOT NULL AND
  chunk_vectors row missing` for the active-building generation, ordered by `chunk.id` for
  determinism; `putEmbeddings(generationId, values)` writes into `chunk_vectors` (sqlite-vec virtual
  table) in one transaction per batch, validating vector dimension against the generation's declared
  `embeddingFingerprint.dimensions` (reject mismatched-dimension batches loudly rather than storing
  malformed vectors — ARC42 §8.6 dimension validation").
- Wire the MCP `lci_index` indexing-flow sequence exactly as ARC42 §6.2's diagram: TS drives the
  embedding loop (native only ever hands out batches / accepts vectors, never calls out over HTTP
  itself), consistent with the boundary re-affirmed by §1.1 above.
- `SemanticSearchService.search`: `sqlite-vec` KNN scoped to `(generation_id)` — mirroring the
  hosted product's own lesson (`docs/indexing-and-storage.md`) that snapshot/generation scoping,
  not an ANN index, is what keeps a per-repo vector search fast; document `score`'s exact meaning in
  the tool response (cosine similarity in `[-1, 1]`, or normalize to `[0, 1]` — pick one and say so
  in Appendix A of ARC42, since §8.11 explicitly calls out "must not mislabel distance as
  probability").
- **Exit:** `lci_search("...")` returns ranked chunks with correct `nodeId` stitched in, against a
  local embedding endpoint (a tiny deterministic fake embedding server for tests — hash-based fake
  vectors, not a real model call, so CI has no external dependency).

### Phase 4 — Freshness, generations, locking, crash recovery

- `IndexLock`: owner token (random UUID) + PID + heartbeat timestamp row in `index_lease`, written
  in the same transaction that flips a generation to `BUILDING`. A process refreshes its heartbeat on
  an interval while indexing; a lease is "abandoned" once `now() - heartbeat > lease_ttl` (**DEFAULT:
  `lease_ttl = 30s`, heartbeat every 10s** — three missed heartbeats before takeover, tunable via
  config later if real-world timing proves it wrong).
- Startup recovery (ARC42 §6.1): on `CodeIndex.open()`, scan for `BUILDING` generations whose lease
  is abandoned → mark `ABANDONED`, leave the previously `ACTIVE` generation untouched.
- Freshness computation (ARC42 §8.6): `indexedHeadSha`/`currentHeadSha` compare, dirty-tree flag from
  `git status --porcelain` (v1: presence/absence only, not a working-tree fingerprint — §11.3
  explicitly defers the fingerprint), schema/extractor/embedding fingerprint compare.
- Concurrency test (Q3 in ARC42 §10.2): two `CodeIndex` handles opened against the same DB file in
  the same test process (simulating two MCP host processes), one calls `beginIndex`, the second's
  `beginIndex` call while the lease is held must return a clear "already indexing" error rather than
  starting a competing generation; both must be able to `search`/`findSymbol` against the still-valid
  `ACTIVE` generation throughout.
- **Exit:** all of ARC42 §10.2's Q1–Q5, Q11 scenarios pass as automated tests.

### Phase 5 — Auth helper

- `auth/helper.ts`: `child_process.spawn` (never `exec`/shell), argv array only, stdout captured to a
  bounded buffer (cap, e.g. 64 KiB — reject and fail loud past that rather than silently truncating
  credentials), stderr captured separately for diagnostics only, `SIGKILL` on timeout.
- Response parsing: accept both the minimal (`{"Authorization": "..."}`) and extended
  (`{"headers": {...}, "expiresAt": "..."}`) shapes from ARC42 §8.3; reject non-string header
  values; reject if stdout contains anything other than exactly one JSON value (trailing garbage is
  an error, not "parse the first value and ignore the rest" — a helper that emits multiple JSON
  values is a bug worth surfacing).
- `auth/cache.ts`: in-memory only for V1 (headers are short-lived credentials; a persistent
  on-disk cache is unnecessary complexity the ARC42 spec doesn't ask for — contrast with
  `clients/lci`'s OIDC *token* cache, which persists because a refresh token is long-lived and OIDC
  round-trips involve a browser). Still worth borrowing one property from that OIDC cache design if
  a future revision adds persistence: absolute `expiresAt`, never a relative TTL re-based off
  process-start time.
- 401/403 → invalidate → one retry (ARC42 §6.6) — implement as a small explicit state machine
  (`Valid | Missing | Invalidated`) in the embedding client's auth-header provider, not scattered
  `if` checks at each call site.
- **Exit:** Q6/Q7 in ARC42 §10.2 pass; a helper writing progress lines to stderr never corrupts a
  concurrent MCP stdout write (verified by a test harness that runs `lci_index` while asserting
  every line on stdout parses as JSON-RPC).

### Phase 6 — Configuration system

- `zod` schema is the single source of truth; export it to JSON Schema (`zod-to-json-schema`) for the
  "future schema URL" ARC42 §8.1 mentions.
- Precedence chain implementation (§6 below) as an explicit ordered list of "layers," each producing
  a partial config object, deep-merged left-to-right — structured this way (rather than an
  imperative `if/else` chain) specifically so the merge order is a data structure that can be unit
  tested directly (`resolveConfig(layers) → merged`), independent of where each layer's raw input
  came from.
- Template expansion (`{{repoRoot}}` etc., ARC42 §8.4): a small explicit interpreter, unknown
  variables are a hard config error (never silently left as literal `{{...}}` text — ARC42 is
  explicit about this).
- `config show` diagnostic command (ARC42 §8.13): reuse the same resolved-config object the server
  itself uses, then run it through a redaction pass (strip `auth.helper` args that look secret-shaped,
  never print resolved header values) before printing.
- **Exit:** Q10 in ARC42 §10.2 passes — a config loaded from `LCI_CONFIG_CONTENT` and the identical
  config loaded from `--config <file>` produce byte-identical resolved config objects.

### Phase 7 — Packaging and release automation

- Platform matrix (ARC42 §7.3): macOS arm64/x64, Linux x64/arm64 glibc, Windows x64 MSVC — five
  napi-rs cross targets, built via `napi build --target <triple>` in CI, one job per target.
- Release ordering mirrors `lci-codegraph`'s own `release.yml` `verify-version` pattern (already a
  proven pattern in this org, see §5 of `lci-codegraph/Cargo.toml`'s comment on the workspace-version
  guard): build+test all targets → publish every platform package → a `verify-version` job asserts
  every published platform package matches the release tag before → publish
  `@vymalo/lightbridge-code-intelligence-native` umbrella → publish
  `@vymalo/lightbridge-code-intelligence-mcp` last, with exact-version `optionalDependencies`.
- musl/Alpine explicitly **out of scope for V1** per ARC42 §7.3 — do not add it speculatively.
- Smoke test per platform: a clean container (no Rust, no system SQLite, no Docker-in-Docker) runs
  `npx @vymalo/lightbridge-code-intelligence-mcp --stdio` and answers `tools/list` — this is Q9 in
  ARC42 §10.2, and it is the one test that can only be caught by literally reproducing "clean
  machine," not by unit tests.
- **Exit:** a real (not dry-run) publish to a scoped `@vymalo` npm tag (`next`/`canary`) round-trips
  through the smoke test above on every target OS.

### Phase 8 — Hardening pass

- Security checklist (ARC42 §8.14) as a literal checklist PR description, each item linked to the
  test or code review comment that verifies it — PDF/file size limits already inherited from
  `lci-codegraph` (verify, don't reimplement); helper output/time bounds from Phase 5; parameterized
  SQL audit (grep for any string-built SQL in `store/`); MCP response size bounds (cap `content`
  field length returned per chunk, matching `lci-codegraph`'s own `max_input_chars` philosophy of
  bounding rather than trusting).
- Load/perf pass: index a real multi-hundred-file OSS repo (reuse one of `lci-codegraph`'s own
  `examples/apps/` fixtures — already vetted, already has metrics tooling via `examples/METRICS.md`'s
  approach) end-to-end through `lci_index`, record wall-clock and peak RSS, sanity-check against
  ARC42's quality tree ("native extraction," "batched embeddings," "bounded retrieval").
- **Exit:** every ARC42 §10.2 quality scenario (Q1–Q12) has a named, passing automated test; the
  security checklist PR is merged.

### Phase 9 — Documentation and GA

- README quickstart (currently just a title — needs the `npx ... --stdio` example, a config
  example, and the OpenCode-style inline-config snippet from ARC42 Appendix C).
- Split ARC42 §9's ADRs into `docs/adr/ADR-LCI-MCP-00N.md` files as the org's convention elsewhere
  (`lci-codegraph/docs/adr/`) already does — one file per decision, easier to link to from PRs than a
  section anchor in a 1800-line spec.
- Tag `v1.0.0`.

---

## 4. Engine crate design details

### 4.1 Cargo dependency set (Phase 0)

| Dependency | Purpose | Note |
|---|---|---|
| `napi`, `napi-derive` | N-API bindings | latest stable `napi-rs` v2/v3 line at time of implementation — confirm current major before Phase 0 |
| `lci-codegraph` | extraction | git dep pinned by `rev` until §1.1's split is published (mirrors `lightbridge-code-intelligence`'s own pinning practice) |
| `rusqlite` (`bundled`, `serde_json`, `functions` features) | storage | `bundled` avoids a system SQLite dependency across every cross-compile target |
| `sqlite-vec` | vector search | registered via `ffi::sqlite3_auto_extension`, see §1.5 |
| `git2` | repo inspection | HEAD, dirty state, remote URL — avoids shelling to `git` |
| `blake3` | `repoKey` hashing | §1.4 |
| `serde`, `serde_json` | DTO (de)serialization across N-API | |
| `thiserror` | typed native error → mapped to MCP tool errors in TS | |
| `tokio` (`rt-multi-thread`) *or* napi-rs's own async-task facility | keeping native calls off the JS event loop | ARC42 §5.4's "must not block the JavaScript event loop" requirement — napi-rs's `#[napi]` `async fn` + `tokio::task::spawn_blocking` around the CPU-bound `walk_checkout` call, exactly mirroring how `lightbridge-code-intelligence`'s own `agent-runner` already wraps this same call (`services/agent-runner/src/indexer/graph.rs`) |

### 4.2 SQLite schema (Phase 1, extended in Phase 3–4)

```sql
CREATE TABLE schema_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL
);

CREATE TABLE repository_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    repo_key TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    remote_identity TEXT              -- NULL when no remote
);

CREATE TABLE index_generations (
    id TEXT PRIMARY KEY,              -- uuid
    state TEXT NOT NULL CHECK (state IN ('BUILDING','ACTIVE','OBSOLETE','FAILED','ABANDONED')),
    created_at INTEGER NOT NULL,       -- unix millis
    activated_at INTEGER,
    head_sha TEXT NOT NULL,
    dirty INTEGER NOT NULL,
    extractor_fingerprint TEXT NOT NULL,
    embedding_fingerprint TEXT,        -- NULL until embeddings configured/run
    failure_reason TEXT
);
-- Exactly one row may have state = 'ACTIVE' at a time; enforced in application code inside the
-- same transaction that performs activation (a partial unique index on state='ACTIVE' is the SQLite
-- idiom: CREATE UNIQUE INDEX ux_one_active ON index_generations(state) WHERE state = 'ACTIVE';).
CREATE UNIQUE INDEX ux_one_active_generation ON index_generations(state) WHERE state = 'ACTIVE';

CREATE TABLE index_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    owner_token TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
);

CREATE TABLE files (
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    file_path TEXT NOT NULL,
    language TEXT,
    content_hash TEXT,                 -- reserved for incremental indexing (§10.2), unused v1
    PRIMARY KEY (generation_id, file_path)
);

CREATE TABLE chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    symbol_name TEXT,
    node_id TEXT,                      -- correlated at write time, see Phase 1; NULL for window/PDF chunks with no graph node
    start_line INTEGER NOT NULL,       -- 0-based, matches lci-codegraph::Chunk
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    embed_input TEXT,                  -- set by prepare_embed_inputs (§1.1); NULL until then
    content_hash TEXT NOT NULL
);
CREATE INDEX ix_chunks_generation_path ON chunks(generation_id, file_path);
CREATE INDEX ix_chunks_generation_node ON chunks(generation_id, node_id);

-- sqlite-vec virtual table, one per embedding dimension actually in use is NOT needed — sqlite-vec
-- supports a fixed dimension per vec0 table, declared at CREATE time from the active
-- embedding_fingerprint.dimensions. Recreated (not migrated) whenever the embedding model/dimension
-- changes, since a generation is immutable once BUILDING starts.
CREATE VIRTUAL TABLE chunk_vectors USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    embedding FLOAT[{dimensions}]
);

CREATE TABLE graph_nodes (
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    node_id TEXT NOT NULL,
    label TEXT NOT NULL,
    source_file TEXT NOT NULL,
    start_line INTEGER NOT NULL,       -- 1-based, matches lci-codegraph::GraphNode
    PRIMARY KEY (generation_id, node_id)
);

CREATE TABLE graph_edges (
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('contains','method','calls'))
);
CREATE INDEX ix_edges_source ON graph_edges(generation_id, source, relation);
CREATE INDEX ix_edges_target ON graph_edges(generation_id, target, relation);
```

Field-for-field, `graph_nodes`/`graph_edges` mirror `lci-codegraph-model::GraphNode`/`GraphEdge`
exactly (§05-model-crate.md) — the same shape `lightbridge-code-intelligence`'s own
`GraphNodePayload`/`GraphEdgePayload` has kept stable across two backend rewrites (Graphify → Neo4j,
now this SQLite target). Reusing it here rather than inventing a new shape is a deliberate choice: it
is a validated, long-lived wire contract, not an accident of convenience.

Migration policy (ARC42 §8.10, Phase 1): `schema_metadata.schema_version` checked on open; V1 has
exactly one version, so the only real logic needed at launch is the *shape* of the decision (migrate
in place / rebuild / refuse) — implement as a `match` over `(found_version, current_version)` that
today only has the `found_version == current_version` arm implemented, with the other arms wired to
a clear "refuse, ask user to delete/rebuild" error rather than left as a `todo!()`, so V2's migration
work has a real seam to extend rather than a stub to first discover exists.

### 4.3 Correlating chunks to graph nodes

Direct port of `lci-codegraph`'s own `ContextIndex::map_chunk` (`src/embed/context.rs`), executed in
`SqliteStore` right after both `chunks` and `graph_nodes` are persisted for a generation:

```sql
UPDATE chunks
SET node_id = (
    SELECT node_id FROM graph_nodes
    WHERE graph_nodes.generation_id = chunks.generation_id
      AND graph_nodes.source_file = chunks.file_path
      AND graph_nodes.start_line = chunks.start_line + 1   -- 0-based chunk line -> 1-based node line
    LIMIT 1
)
WHERE generation_id = ?;
```

### 4.4 Public N-API surface

As specified in ARC42 §5.4, with these additions the plan surfaces that ARC42 leaves implicit:

```ts
interface IndexGenerationHandle { generationId: string; }

class CodeIndex {
  static open(options: OpenIndexOptions): Promise<CodeIndex>;
  status(): Promise<IndexStatus>;

  beginIndex(options: StartIndexOptions): Promise<IndexGenerationHandle>;
  // Also implicitly performs the native (embed-config-free) extraction + graph-node correlation +
  // embed_input population for the WHOLE generation before returning — i.e. by the time this
  // resolves, every chunk needing embeddings has a non-null embed_input and nextEmbeddingBatch has
  // something to hand out. This keeps the "extraction is one atomic native step" property Phase 1
  // establishes; only the embeddings loop is chunked into TS-visible batches.

  nextEmbeddingBatch(generationId: string, limit: number): Promise<EmbeddingBatchItem[]>;
  putEmbeddings(generationId: string, values: EmbeddingResult[]): Promise<void>;
  commitIndex(generationId: string): Promise<void>;   // validates every chunk needing a vector has one
  failIndex(generationId: string, reason: string): Promise<void>;
  heartbeatLease(generationId: string): Promise<void>; // called by TS on an interval during beginIndex..commitIndex

  search(input: SearchInput): Promise<SearchResult>;
  findSymbol(input: FindSymbolInput): Promise<SymbolResult>;
  callers(input: TraversalInput): Promise<GraphResult>;
  callees(input: TraversalInput): Promise<GraphResult>;
  exploreSymbol(input: ExploreSymbolInput): Promise<ExploreResult>;
}
```

Every method is `async` at the napi-rs boundary (returns a JS `Promise` backed by a Rust future that
internally uses `spawn_blocking` for the CPU/IO-bound body) — no synchronous native call is exposed,
closing off an entire class of "accidentally blocked the event loop" bugs before they can be written.

---

## 5. Graph query service — SQL translated from the production Cypher

Every query below is a direct SQL translation of the Cypher already running in production
(`lightbridge-code-intelligence`'s `services/control-plane/src/integrations/neo4j.rs`), scoped to
`generation_id` instead of `(repo_id, commit)` since a generation already encodes that scope.

### 5.1 `find_symbol` (case-insensitive substring over label/node_id/source_file)

```sql
SELECT node_id, label, source_file, start_line
FROM graph_nodes
WHERE generation_id = ?1
  AND (label LIKE '%' || ?2 || '%' COLLATE NOCASE
       OR node_id LIKE '%' || ?2 || '%' COLLATE NOCASE
       OR source_file LIKE '%' || ?2 || '%' COLLATE NOCASE)
LIMIT ?3;
```

(A `LIKE '%term%'` cannot use a plain b-tree index and degrades to a scan — acceptable at V1's scale
per the ARC42 non-goal on multi-user/large-monorepo distributed indexing; if this becomes a hot path
against very large graphs, an FTS5 index over `graph_nodes(label, node_id, source_file)` is the
natural upgrade, no schema-breaking change required.)

### 5.2 `get_callers` / `get_callees` (single-hop reverse/forward `calls` traversal)

```sql
-- callers
SELECT n.node_id, n.label, n.source_file, n.start_line
FROM graph_edges e
JOIN graph_nodes n ON n.generation_id = e.generation_id AND n.node_id = e.source
WHERE e.generation_id = ?1 AND e.relation = 'calls' AND e.target = ?2
LIMIT ?3;

-- callees (swap source/target)
SELECT n.node_id, n.label, n.source_file, n.start_line
FROM graph_edges e
JOIN graph_nodes n ON n.generation_id = e.generation_id AND n.node_id = e.target
WHERE e.generation_id = ?1 AND e.relation = 'calls' AND e.source = ?2
LIMIT ?3;
```

`depth > 1` (ARC42's `TraversalInput.depth`) generalizes both into the recursive form below with
direction fixed to one side.

### 5.3 `explore_symbol` — bounded, cycle-safe, bidirectional neighborhood

```sql
WITH RECURSIVE frontier(node_id, depth, direction) AS (
    SELECT ?1, 0, 'origin'
    UNION
    SELECT e.target, f.depth + 1, 'out'
    FROM graph_edges e
    JOIN frontier f ON e.source = f.node_id AND e.generation_id = ?2
    WHERE f.depth < ?3 AND e.relation = 'calls'   -- calleesDepth clamp applied at bind time
    UNION
    SELECT e.source, f.depth + 1, 'in'
    FROM graph_edges e
    JOIN frontier f ON e.target = f.node_id AND e.generation_id = ?2
    WHERE f.depth < ?4 AND e.relation = 'calls'   -- callersDepth clamp applied at bind time
)
SELECT DISTINCT node_id FROM frontier;
```

`UNION` (not `UNION ALL`) both dedups and is what makes this terminate correctly on a cycle
(`a → b → a`) — SQLite's recursive CTE evaluation stops recursing down a branch once a row it already
produced would recur, but only because `UNION`'s implicit dedup prevents the same `(node_id, depth,
direction)` tuple from re-queuing infinitely; the additional application-level hard cap on `depth`
(clamped 1..3 server-side regardless of client input, per ARC42 §8.12) is a defense-in-depth bound,
not the only thing preventing runaway recursion. A second query (mirroring the hosted product's
`edges_among`) then fetches the induced-subgraph edges among the resulting node-id set for the
convenience response ARC42 §Appendix A's `lci_explore_symbol` describes (container, callers, callees,
source location together):

```sql
SELECT source, target, relation FROM graph_edges
WHERE generation_id = ?1 AND source IN (SELECT node_id FROM frontier_result)
                        AND target IN (SELECT node_id FROM frontier_result);
```

### 5.4 Semantic search (`sqlite-vec` KNN)

```sql
SELECT c.id AS chunk_id, c.node_id, c.symbol_name, c.file_path, c.start_line, c.end_line, c.content,
       v.distance
FROM chunk_vectors v
JOIN chunks c ON c.id = v.chunk_id
WHERE c.generation_id = ?1
  AND v.embedding MATCH ?2          -- query vector, sqlite-vec KNN syntax
  AND k = ?3
ORDER BY v.distance
LIMIT ?3;
```

Apply `path`/`language` filters (ARC42 §8.11) as additional `AND c.file_path LIKE ...` /
`AND c.language = ...` predicates in the same query — sqlite-vec's `vec0` virtual table supports
auxiliary/metadata columns for exactly this, but starting with a post-filter join against `chunks` is
simpler and avoids a schema decision (partitioned vec0 tables) that isn't needed until profiling shows
it matters.

**`score` definition (must be fixed before Phase 3 ships, ARC42 §8.11):** `sqlite-vec`'s `distance`
column for a cosine-configured `vec0` table is `1 - cosine_similarity`, i.e. **lower is more similar**
— the inverse of what a naive "score" reader expects. **DEFAULT:** the MCP tool response's `score`
field is `1 - distance` (so higher = more similar, `[-1, 1]` range, documented in Appendix A's
response schema as "cosine similarity, higher is more relevant" — never expose raw `distance` under
a field named `score`).

---

## 6. Configuration precedence — implementation shape

Directly generalizes the `clients/lci` precedent (`Config::resolve`, explicit `.or_else()` chain)
into a data-driven layer list rather than a hand-written chain, since lci-mcp's precedence order
(ARC42 §8.1) has six layers, not four flat scalars:

```ts
type ConfigLayer = { name: string; value: Partial<LciConfig> | undefined };

function resolveConfig(layers: ConfigLayer[]): LciConfig {
  const merged = layers.reduce(
    (acc, layer) => (layer.value ? deepMergeReplacingArrays(acc, layer.value) : acc),
    BUILT_IN_DEFAULTS,
  );
  return LciConfigSchema.parse(merged); // zod: throws with a precise path on the first invalid field
}

// layers, in ARC42 §8.1 order (lowest → highest priority):
[
  { name: "defaults", value: BUILT_IN_DEFAULTS },
  { name: "global", value: loadDiscoveredGlobalConfig() },      // e.g. ~/.config/lci/config.json
  { name: "file", value: loadFileConfig(argv.config) },
  { name: "env-content", value: parseJson(process.env.LCI_CONFIG_CONTENT) },
  { name: "inline-json", value: parseJson(argv.configJson) },
  { name: "cli-flags", value: flagsToPartialConfig(argv) },
]
```

`deepMergeReplacingArrays`: objects deep-merge, arrays replace wholesale — per ARC42 §8.1's explicit
"V1 should prefer replacement semantics" default. Each layer's raw source is resolved *before*
merging (so a malformed `--config-json` fails with a clear "layer: inline-json" error, not a
confusing downstream Zod error with no indication which layer introduced the bad value).

---

## 7. Embedding client — TS design mirrored from `services/agent-clients/src/embeddings.rs`

| Behavior | Source precedent | lci-mcp application |
|---|---|---|
| Batch request, single POST per batch | `embed_once`, batches formed one layer up | native `nextEmbeddingBatch(limit)` sizes the batch (config `embedding.batchSize`, default 64 per ARC42 §8.2 example) |
| Response reordered by response `index`, never trust array position | `embeddings.rs` lines ~216–226 | identical logic in TS; hard error if returned count ≠ input count |
| Retry only connect/timeout/429/5xx; other 4xx fail immediately | `embeddings.rs` retry loop | identical policy; auth 401/403 specifically routes through the auth-helper invalidate-and-retry-once path (§Phase 5), not the generic retry loop |
| Exponential backoff, `BASE_BACKOFF=500ms`, cap `MAX_BACKOFF=8s`, honor `Retry-After` | same | same constants as a starting point; expose as config only if a real need arises — don't add knobs speculatively |
| Deterministic jitter (no RNG) for stable tests | `(attempt).wrapping_mul(2_654_435_761) % 250` | port the identical formula so lci-mcp's own retry tests are equally deterministic |
| Never log request body (source code) in errors, only response body, truncated | `embeddings.rs` | identical — ARC42 §8.13's "no secrets in logs" plus this org's existing "don't leak repo source into aggregated logs" lesson |
| Empty input ⇒ no HTTP call | `embeddings.rs` line ~123 | `nextEmbeddingBatch` returning `[]` short-circuits without a request |
| `encoding_format: "float"` always sent explicitly | `lci-codegraph`'s own `embed/client.rs` (same lesson, independently learned) | same — avoids a gateway defaulting to base64 |

---

## 8. MCP tool layer

Use `@modelcontextprotocol/sdk` (the official TS SDK) directly — the research pass found **no**
existing TypeScript MCP server anywhere in the org to mirror (both existing servers,
`services/review-mcp` and `services/control-plane/src/mcp`, are Rust), so there's no in-house TS
precedent to match, only a design lesson to port from the Rust `rmcp`-based server
(`services/control-plane/src/mcp/handler.rs`): **one function per tool, a typed input schema (Zod
here, `schemars`/`Parameters<T>` there) and a typed output shape (Zod-validated response object, not
an ad hoc `any`), never a single grab-bag dispatch function with a stringly-typed `op` field.** This
is the opposite of `services/review-mcp`'s pattern (a name-mapped proxy over an existing native tool
registry, `control_plane`'s `graph_search` tool's `query_type` string dispatch) — those exist for
reasons specific to their own migration history, not because they're the right shape for a
fresh server.

```ts
// server/src/mcp/tools/search.ts
const SearchInput = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(50).default(10),
  path: z.string().optional(),
  language: z.string().optional(),
});

server.registerTool("lci_search", {
  description: "Semantic code/document search over the local index. Returns evidence, not an answer.",
  inputSchema: SearchInput,
}, async (input) => {
  const vector = await embeddingClient.embed([input.query]);
  const result = await codeIndex.search({ vector: vector[0], ...input });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
```

Error mapping: native errors are `thiserror`-typed in Rust, cross the N-API boundary as
`{ code, message }`, and the MCP layer maps known codes to actionable tool-error text (e.g.
`INDEX_NEVER_RAN` → "no index exists yet; call lci_index first") rather than leaking a raw Rust
panic message or stack trace to the model.

---

## 9. Testing strategy

1. **Engine unit tests** (`cargo test`, no Docker): schema/migration behavior, `repoKey` algorithm
   edge cases (§1.4's four required cases from ARC42 §8.5), lease heartbeat/expiry timing, chunk↔node
   correlation.
2. **Engine SQL query tests**: reuse `lci-codegraph`'s own `tests/fixtures/sample-repo` fixture and
   assert the exact same caller/callee/find-symbol facts `lci-codegraph/tests/container_neo4j.rs`
   already asserts against Neo4j — this is a strong regression net precisely because the expected
   answers are already known-correct and independently verified elsewhere.
3. **TS unit tests** (vitest): config precedence/merge, template expansion, embedding-client
   retry/backoff/reordering against a mock HTTP server (`msw` or a local `http.Server`), auth-helper
   spawn/parse/cache against a fake helper script.
4. **MCP protocol e2e tests** (`e2e/`): spawn the actual built CLI as a child process with `--stdio`,
   speak real JSON-RPC over its stdin/stdout, assert `tools/list` schema shape and a full
   index→search→explore round trip against a small fixture repo — the only tests that exercise the
   full TS↔native↔MCP-host boundary together.
5. **Determinism tests**: two full `lci_index` runs over the same unchanged fixture produce
   byte-identical `graph_nodes`/`graph_edges` rows and identical `embed_input` strings (embedding
   vectors themselves aren't compared byte-identical against a real provider, but *are* against the
   deterministic fake embedding server used in CI).
6. **Platform smoke tests** (Phase 7): clean-container `npx` run per target OS, no Rust/SQLite/Docker
   present.

---

## 10. Summary — Definition of Done for V1

- [ ] All items in ARC42 §10.2 (Q1–Q12) pass as named automated tests.
- [ ] All seven Appendix A tools implemented, schema-documented, and covered by an e2e test.
- [ ] `lci-codegraph`'s `embed_input` split (§1.1) is either upstreamed or the fork-branch dependency
      is explicitly tracked with a removal plan.
- [ ] `repoKey` algorithm (§1.4) is locked, tested against all required edge cases, and documented in
      `config show` output.
- [ ] Five-platform release pipeline (§Phase 7) has completed at least one real publish with a
      passing clean-machine smoke test on every target.
- [ ] Security checklist (ARC42 §8.14) fully checked off against actual code, not just design intent.
- [ ] README quickstart verified by literally running the documented `npx` command against a fresh
      checkout with no prior local state.
