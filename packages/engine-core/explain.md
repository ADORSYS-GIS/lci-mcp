# packages/engine-core — explained

Pure Rust. No N-API dependency at all — this crate doesn't know it's ever going to be wrapped in a
native Node addon. That's deliberate: it's what makes `cargo test` work here like it would in any
ordinary Rust project, including real integration tests that index actual open-source repositories
and check the result against a committed golden graph.

## What lives here

```text
src/
├── lib.rs                 module declarations + re-exports
├── dto.rs                  plain data types shared across store/ and index_coordinator
├── error.rs                 EngineError — every named domain failure mode
├── repository.rs            repoKey / HEAD / dirty-state resolution (git2, git-optional)
├── extractor.rs              the lci-codegraph tree-sitter walk
├── lease.rs                   cross-process indexing-lease coordination
├── index_coordinator.rs        orchestrates one index generation end to end
└── store/
    ├── mod.rs                SqliteStore — the one connection, generation bookkeeping
    ├── schema.rs               migration runner
    ├── chunks.rs                chunk/graph persistence, embedding-batch queries
    ├── graph.rs                  find_symbol / callers / callees / explore_symbol
    └── vectors.rs                 put_embeddings / search
migrations/
└── 0001_init.sql             the schema DDL, embedded into the binary at build time
```

## The one connection

```rust
// store/mod.rs
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(database_path: &Path) -> anyhow::Result<Self> {
        register_vector_extension();
        let conn = Connection::open(database_path)?;
        schema::ensure_schema(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> anyhow::Result<T>) -> anyhow::Result<T> {
        let conn = self.conn.lock().expect("sqlite connection mutex poisoned");
        f(&conn)
    }
}
```

Every table, every query, everywhere in this crate goes through that one `Mutex<Connection>` — WAL
mode, foreign keys, and the `sqlite-vec` extension are all registered on it once, at `open()`. The
`Mutex` also doubles as the serialization point for anything that needs to be atomic: wrap several
statements in one `with_conn` closure and nothing else can interleave.

## Schema: migrations, not a hand-maintained string

```rust
// store/schema.rs
const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../../migrations/0001_init.sql"))];
pub const CURRENT_SCHEMA_VERSION: i64 = 1;

pub fn ensure_schema(conn: &Connection) -> anyhow::Result<()> {
    let found_version: i64 = conn
        .query_row("SELECT schema_version FROM schema_metadata WHERE id = 1", [], |r| r.get(0))
        .ok()
        .unwrap_or(0);

    for (version, sql) in MIGRATIONS {
        if *version <= found_version { continue; }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute("INSERT INTO schema_metadata (id, schema_version) VALUES (1, ?1) \
                     ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version", [version])?;
        tx.commit()?;
    }
    Ok(())
}
```

Each `migrations/NNNN_name.sql` file is one forward-only step, pulled into the compiled binary via
`include_str!` (there's no filesystem to read from once this ships as a native addon — the `.sql`
files have to already be inside the binary). A migration's DDL and its version bump commit together
in one transaction, so a crash mid-migration leaves the recorded version untouched and the next run
retries the same file cleanly rather than resuming half-applied.

## Real, matchable errors

```rust
// error.rs
#[derive(Debug, Error, PartialEq, Eq)]
pub enum EngineError {
    LeaseHeld { owner_pid: i64, generation_id: String, heartbeat_ago_ms: i64 },
    LeaseLost,
    NoSuchGeneration(String),
    NotBuilding { generation_id: String, state: String },
    EmbeddingsIncomplete { generation_id: String, pending: i64 },
    ActivationRejected { generation_id: String },
    IncompatibleSchema { found: i64, expected: i64 },
    DimensionMismatch { expected: u32, actual: usize, chunk_id: i64 },
}
```

Every function still returns plain `anyhow::Result<T>` — no signature churn — but the *value*
constructed at each failure point is one of these named variants, not an ad-hoc formatted string.
`anyhow::Error: From<E: std::error::Error>` means `?`/`.into()` carries it across automatically, and
a caller (or a test) that cares can `err.downcast_ref::<EngineError>()` and match the real variant
instead of substring-checking `to_string()`.

## The generation lifecycle, in one call

```rust
// index_coordinator.rs
pub async fn begin_index(
    store: &SqliteStore, repo_root: &Path, owner_token: &str, options: &StartIndexOptions,
) -> anyhow::Result<IndexGenerationHandle> {
    let repo_info = repository::inspect(repo_root)?;
    store.set_repository_metadata(&repo_info.repo_key, ..., repo_info.remote_identity.as_deref())?;

    let generation_id = Uuid::new_v4().to_string();
    store.begin_generation(&generation_id, &repo_info.head_sha, repo_info.dirty,
        &extractor_fingerprint(), options.embedding_fingerprint.as_deref(),
        owner_token, std::process::id() as i64)?;

    let outcome = extract_and_persist(store, repo_root, &generation_id).await;
    if let Err(err) = &outcome {
        store.fail_generation(&generation_id, &err.to_string())?;
        store.with_conn(|conn| lease::release(conn, owner_token))?;
    }
    outcome?;
    Ok(IndexGenerationHandle { generation_id })
}
```

`begin_generation` (in `store/mod.rs`) is the one function that gets this right atomically: it
checks no other live lease exists, creates the `BUILDING` row, and acquires the lease for it, all
inside one transaction — so two overlapping calls can't both observe "no live lease" and race each
other into existence. `extract_and_persist` then runs the actual `lci-codegraph` tree-sitter walk
and inserts every chunk, graph node, and graph edge in a single transaction. Activation
(`BUILDING → ACTIVE`, previous `ACTIVE → OBSOLETE`) is a separate, later call
(`commit_index`/`activate_generation`) — see [ADR-0004](../../docs/adr/0004-generation-based-indexing.md)
for why the lifecycle is shaped this way.

## Querying: graph and vectors

```rust
// store/vectors.rs — semantic search
let candidate_pool = (limit * 10).min(2000);
let sql = "SELECT ... FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id \
           WHERE c.generation_id = ?1 AND v.embedding MATCH ?2 AND k = ?3 \
           [AND c.file_path LIKE ...] [AND c.language = ...] \
           ORDER BY v.distance LIMIT ?N";
```

`k` over-fetches a larger candidate pool than the caller's `limit` before the generation/path/language
filters get applied — `vec0`'s nearest-neighbor scan happens *before* those filters, so asking for
exactly `limit` candidates can starve them.

```rust
// store/graph.rs — bounded recursive traversal
"WITH RECURSIVE frontier(node_id, depth) AS (
    SELECT ?1, 0
    UNION
    SELECT e.target, f.depth + 1 FROM graph_edges e JOIN frontier f ON e.source = f.node_id
     WHERE e.generation_id = ?2 AND e.relation = 'calls' AND f.depth < ?3
    UNION
    SELECT e.source, f.depth + 1 FROM graph_edges e JOIN frontier f ON e.target = f.node_id
     WHERE e.generation_id = ?2 AND e.relation = 'calls' AND f.depth < ?4
)
SELECT DISTINCT n.node_id, n.label, n.source_file, n.start_line FROM frontier f JOIN graph_nodes n ..."
```

`UNION` (not `UNION ALL`) is load-bearing here — it dedups *and* is what makes the recursion
terminate on a call cycle.

## Testing

```bash
cargo test              # unit tests, in every module above
cargo test --test real_repos  # indexes real Axum + Spring Boot fixtures, asserts against golden graphs
```

`tests/real_repos.rs` is the closest thing to an end-to-end proof this crate has on its own: real
source code in, real tree-sitter parsing, real SQLite persistence, assertions against a committed
"golden graph" — including cross-file call resolution (interface → implementation, a Spring Data
repository method with no body anywhere in source).
