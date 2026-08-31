//! N-API surface: the `CodeIndex` class. Every method converts its napi-facing DTO and calls
//! straight into the core crate, which carries all the actual logic. Every method is `async`, with
//! the blocking body run through `spawn_blocking`, so no call blocks the Node.js event loop.

mod dto;

use std::path::PathBuf;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use uuid::Uuid;

use lci_mcp_engine_core::store::SqliteStore;
use lci_mcp_engine_core::{index_coordinator, repository};

pub use dto::*;

/// Resolves repository identity without an open `CodeIndex` — a caller needs `repoKey` to build a
/// storage path before it knows what to pass to `CodeIndex.open()`.
#[napi]
pub async fn repository_identity(repository_root: String) -> Result<RepositoryIdentity> {
    blocking(move || {
        let info = repository::inspect(std::path::Path::new(&repository_root))?;
        Ok(RepositoryIdentity {
            repo_key: info.repo_key,
            canonical_root: info.canonical_root.to_string_lossy().to_string(),
            head_sha: info.head_sha,
            dirty: info.dirty,
            remote_identity: info.remote_identity,
        })
    })
    .await
}

#[napi]
pub struct CodeIndex {
    store: Arc<SqliteStore>,
    repo_root: PathBuf,
    database_path: String,
    owner_token: String,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Error::from_reason(format!("engine task panicked: {e}")))?
        .map_err(Error::from)
}

#[napi]
impl CodeIndex {
    #[napi]
    pub async fn open(options: OpenIndexOptions) -> Result<CodeIndex> {
        let repo_root = PathBuf::from(options.repository);
        let database_path = options.database;
        let db_path_for_task = database_path.clone();
        let store = blocking(move || SqliteStore::open(std::path::Path::new(&db_path_for_task)).map(Arc::new)).await?;

        let recovered_store = Arc::clone(&store);
        blocking(move || recovered_store.recover_abandoned_generations()).await?;

        Ok(CodeIndex { store, repo_root, database_path, owner_token: Uuid::new_v4().to_string() })
    }

    #[napi]
    pub async fn status(&self) -> Result<IndexStatus> {
        let store = Arc::clone(&self.store);
        let repo_root = self.repo_root.clone();
        let database_path = self.database_path.clone();
        blocking(move || index_coordinator::status(&store, &repo_root, &database_path).map(Into::into)).await
    }

    #[napi]
    pub async fn begin_index(&self, options: StartIndexOptions) -> Result<IndexGenerationHandle> {
        // Not wrapped in `blocking()`: `index_coordinator::begin_index` is itself `async` and already
        // pushes the one genuinely expensive step (the tree-sitter walk, inside `extractor::extract`)
        // onto `spawn_blocking` — wrapping this whole call in another `spawn_blocking` would mean
        // calling `block_on` from within a blocking-pool thread just to re-enter the async runtime,
        // which works but adds a needless nested-runtime hop for no benefit.
        index_coordinator::begin_index(&self.store, &self.repo_root, &self.owner_token, &options.into())
            .await
            .map(Into::into)
            .map_err(Error::from)
    }

    #[napi]
    pub async fn next_embedding_batch(&self, generation_id: String, limit: i64) -> Result<Vec<EmbeddingBatchItem>> {
        let store = Arc::clone(&self.store);
        blocking(move || {
            Ok(index_coordinator::next_embedding_batch(&store, &generation_id, limit)?
                .into_iter()
                .map(Into::into)
                .collect())
        })
        .await
    }

    #[napi]
    pub async fn put_embeddings(&self, generation_id: String, values: Vec<EmbeddingResult>, dimensions: i64) -> Result<()> {
        let store = Arc::clone(&self.store);
        let values: Vec<_> = values.into_iter().map(Into::into).collect();
        blocking(move || index_coordinator::put_embeddings(&store, &generation_id, &values, dimensions)).await
    }

    #[napi]
    pub async fn commit_index(&self, generation_id: String) -> Result<()> {
        let store = Arc::clone(&self.store);
        let owner_token = self.owner_token.clone();
        blocking(move || index_coordinator::commit_index(&store, &generation_id, &owner_token)).await
    }

    #[napi]
    pub async fn fail_index(&self, generation_id: String, reason: String) -> Result<()> {
        let store = Arc::clone(&self.store);
        let owner_token = self.owner_token.clone();
        blocking(move || index_coordinator::fail_index(&store, &generation_id, &reason, &owner_token)).await
    }

    #[napi]
    pub async fn heartbeat_lease(&self) -> Result<()> {
        let store = Arc::clone(&self.store);
        let owner_token = self.owner_token.clone();
        blocking(move || index_coordinator::heartbeat_lease(&store, &owner_token)).await
    }

    #[napi]
    pub async fn search(&self, input: SearchInput) -> Result<Vec<SearchHit>> {
        let store = Arc::clone(&self.store);
        let input: lci_mcp_engine_core::dto::SearchInput = input.into();
        blocking(move || {
            let active = store
                .get_active_generation()?
                .ok_or_else(|| anyhow::anyhow!("no active index generation — call beginIndex/commitIndex first"))?;
            let hits = store.with_conn(|conn| lci_mcp_engine_core::store::vectors::search(conn, &active.id, &input))?;
            Ok(hits.into_iter().map(Into::into).collect())
        })
        .await
    }

    #[napi]
    pub async fn find_symbol(&self, input: FindSymbolInput) -> Result<Vec<SymbolHit>> {
        let store = Arc::clone(&self.store);
        blocking(move || {
            let active = active_generation(&store)?;
            let hits = store.with_conn(|conn| lci_mcp_engine_core::store::graph::find_symbol(conn, &active.id, &input.term, input.limit))?;
            Ok(hits.into_iter().map(Into::into).collect())
        })
        .await
    }

    #[napi]
    pub async fn callers(&self, input: TraversalInput) -> Result<Vec<SymbolHit>> {
        let store = Arc::clone(&self.store);
        blocking(move || {
            let active = active_generation(&store)?;
            let hits =
                store.with_conn(|conn| lci_mcp_engine_core::store::graph::get_callers(conn, &active.id, &input.node_id, input.limit))?;
            Ok(hits.into_iter().map(Into::into).collect())
        })
        .await
    }

    #[napi]
    pub async fn callees(&self, input: TraversalInput) -> Result<Vec<SymbolHit>> {
        let store = Arc::clone(&self.store);
        blocking(move || {
            let active = active_generation(&store)?;
            let hits =
                store.with_conn(|conn| lci_mcp_engine_core::store::graph::get_callees(conn, &active.id, &input.node_id, input.limit))?;
            Ok(hits.into_iter().map(Into::into).collect())
        })
        .await
    }

    #[napi]
    pub async fn explore_symbol(&self, input: ExploreSymbolInput) -> Result<ExploreResult> {
        let store = Arc::clone(&self.store);
        blocking(move || {
            let active = active_generation(&store)?;
            let result = store.with_conn(|conn| {
                lci_mcp_engine_core::store::graph::explore_symbol(
                    conn,
                    &active.id,
                    &input.node_id,
                    input.callers_depth,
                    input.callees_depth,
                    input.limit,
                )
            })?;
            Ok(result.into())
        })
        .await
    }
}

fn active_generation(store: &SqliteStore) -> anyhow::Result<lci_mcp_engine_core::store::GenerationRow> {
    store
        .get_active_generation()?
        .ok_or_else(|| anyhow::anyhow!("no active index generation — call beginIndex/commitIndex first"))
}
