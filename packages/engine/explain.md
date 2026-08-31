# packages/engine — explained

The thin native boundary. This crate has almost no logic of its own — its entire job is converting
between plain JS-facing DTOs and `engine-core`'s Rust types, and running every call through
`spawn_blocking` so nothing here ever blocks Node's event loop. Published as
`@vymalo/lightbridge-code-intelligence-native`.

## What lives here

```text
src/
├── lib.rs    the CodeIndex #[napi] class — every method, same shape
└── dto.rs     napi-facing structs mirroring engine-core's dto.rs field-for-field
```

That's it. No `store/`, no `index_coordinator`, no SQL — all of that stays in `engine-core`. This
crate exists purely because of one constraint: a `#[napi]`-decorated crate emits module-registration
hooks that only resolve inside a real Node process, which would break `engine-core`'s own
`cargo test` if the two were merged. See
[ADR-0005](../../docs/adr/0005-separate-core-crate-from-napi-binding-crate.md).

## The pattern, once

```rust
// lib.rs
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Error::from_reason(format!("engine task panicked: {e}")))?
        .map_err(Error::from)
}

#[napi]
pub struct CodeIndex {
    store: Arc<SqliteStore>,
    repo_root: PathBuf,
    database_path: String,
    owner_token: String,
}
```

Every method on `CodeIndex` follows the same shape: clone the `Arc<SqliteStore>`, move it into a
`blocking` closure, call straight into `engine-core`, convert the result with `.into()`:

```rust
#[napi]
pub async fn find_symbol(&self, input: FindSymbolInput) -> Result<Vec<SymbolHit>> {
    let store = Arc::clone(&self.store);
    blocking(move || {
        let active = active_generation(&store)?;
        let hits = store.with_conn(|conn| {
            lci_mcp_engine_core::store::graph::find_symbol(conn, &active.id, &input.term, input.limit)
        })?;
        Ok(hits.into_iter().map(Into::into).collect())
    })
    .await
}
```

The full method list mirrors `engine-core`'s public surface one-to-one: `open`, `status`,
`beginIndex`, `nextEmbeddingBatch`, `putEmbeddings`, `commitIndex`, `failIndex`, `heartbeatLease`,
`search`, `findSymbol`, `callers`, `callees`, `exploreSymbol` — plus a standalone
`repositoryIdentity(root)` function for resolving `repoKey`/HEAD/dirty before a `CodeIndex` is even
open.

## DTO conversion, both directions

```rust
// dto.rs
#[napi(object)]
#[derive(Debug, Clone)]
pub struct SearchInput {
    pub vector: Vec<f64>,
    pub limit: Option<i64>,
    pub path: Option<String>,
    pub language: Option<String>,
}

impl From<SearchInput> for core::SearchInput {
    fn from(v: SearchInput) -> Self {
        Self { vector: v.vector, limit: v.limit, path: v.path, language: v.language }
    }
}
```

Every napi-facing struct has a matching plain struct in `engine-core::dto`, plus a `From` impl in
one direction or the other (input types convert *into* the core type; output types convert *from*
it). A few — `FindSymbolInput`, `TraversalInput`, `ExploreSymbolInput`, `OpenIndexOptions`,
`RepositoryIdentity` — have no core counterpart at all, because the functions they feed take plain
arguments rather than a struct, or because they're only ever constructed inside this crate.

## What this compiles to

```json
// package.json
{
  "name": "@vymalo/lightbridge-code-intelligence-native",
  "napi": {
    "binaryName": "lci-mcp-engine",
    "targets": [
      "x86_64-unknown-linux-gnu", "x86_64-apple-darwin", "aarch64-apple-darwin",
      "aarch64-unknown-linux-gnu", "x86_64-pc-windows-msvc"
    ]
  }
}
```

`napi build --platform --release` (the `build` script) produces a platform-specific `.node` binary
next to `index.js`/`index.d.ts` — the actual compiled Rust, not JavaScript. `packages/server`
imports this package exactly like any other npm dependency; from its side, `CodeIndex` is just a
class with async methods. There's no IPC, no HTTP, no serialization boundary beyond napi-rs
converting the plain JS objects into the Rust structs above and back.
