//! N-API object types, mirroring the core crate's plain data types field-for-field, plus a few
//! input/handle types that only ever exist at this boundary.

use napi_derive::napi;

use lci_mcp_engine_core::dto as core;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct SymbolHit {
    pub node_id: String,
    pub label: String,
    pub source_file: String,
    pub start_line: i64,
}

impl From<core::SymbolHit> for SymbolHit {
    fn from(v: core::SymbolHit) -> Self {
        Self { node_id: v.node_id, label: v.label, source_file: v.source_file, start_line: v.start_line }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct GraphEdgeHit {
    pub source: String,
    pub target: String,
    pub relation: String,
}

impl From<core::GraphEdgeHit> for GraphEdgeHit {
    fn from(v: core::GraphEdgeHit) -> Self {
        Self { source: v.source, target: v.target, relation: v.relation }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ExploreResult {
    pub nodes: Vec<SymbolHit>,
    pub edges: Vec<GraphEdgeHit>,
}

impl From<core::ExploreResult> for ExploreResult {
    fn from(v: core::ExploreResult) -> Self {
        Self {
            nodes: v.nodes.into_iter().map(Into::into).collect(),
            edges: v.edges.into_iter().map(Into::into).collect(),
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub chunk_id: i64,
    pub node_id: Option<String>,
    pub symbol_name: Option<String>,
    pub file_path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub content: String,
    /// Cosine similarity, higher is more relevant.
    pub score: f64,
}

impl From<core::SearchHit> for SearchHit {
    fn from(v: core::SearchHit) -> Self {
        Self {
            chunk_id: v.chunk_id,
            node_id: v.node_id,
            symbol_name: v.symbol_name,
            file_path: v.file_path,
            start_line: v.start_line,
            end_line: v.end_line,
            content: v.content,
            score: v.score,
        }
    }
}

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

/// No core counterpart — `store::graph::find_symbol` takes plain fields, not this struct.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FindSymbolInput {
    pub term: String,
    pub limit: Option<i64>,
}

/// No core counterpart — see `FindSymbolInput`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct TraversalInput {
    pub node_id: String,
    pub limit: Option<i64>,
}

/// No core counterpart — see `FindSymbolInput`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ExploreSymbolInput {
    pub node_id: String,
    pub callers_depth: Option<i64>,
    pub callees_depth: Option<i64>,
    pub limit: Option<i64>,
}

/// No core counterpart — only ever constructed inside `lib.rs` from `repository::inspect`'s result.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct OpenIndexOptions {
    pub repository: String,
    pub database: String,
}

/// No core counterpart — only ever constructed inside `lib.rs` from `repository::inspect`'s result.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct RepositoryIdentity {
    pub repo_key: String,
    pub canonical_root: String,
    pub head_sha: String,
    pub dirty: bool,
    pub remote_identity: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct StartIndexOptions {
    /// Identifies the embedding model/config in use. `None` means this generation is structural only.
    pub embedding_fingerprint: Option<String>,
    pub embedding_dimensions: Option<i64>,
}

impl From<StartIndexOptions> for core::StartIndexOptions {
    fn from(v: StartIndexOptions) -> Self {
        Self { embedding_fingerprint: v.embedding_fingerprint, embedding_dimensions: v.embedding_dimensions }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct IndexGenerationHandle {
    pub generation_id: String,
}

impl From<core::IndexGenerationHandle> for IndexGenerationHandle {
    fn from(v: core::IndexGenerationHandle) -> Self {
        Self { generation_id: v.generation_id }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct EmbeddingBatchItem {
    pub id: i64,
    pub text: String,
}

impl From<core::EmbeddingBatchItem> for EmbeddingBatchItem {
    fn from(v: core::EmbeddingBatchItem) -> Self {
        Self { id: v.id, text: v.text }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct EmbeddingResult {
    pub id: i64,
    pub vector: Vec<f64>,
}

impl From<EmbeddingResult> for core::EmbeddingResult {
    fn from(v: EmbeddingResult) -> Self {
        Self { id: v.id, vector: v.vector }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RevisionInfo {
    pub indexed_head_sha: Option<String>,
    pub current_head_sha: String,
    pub dirty: bool,
}

impl From<core::RevisionInfo> for RevisionInfo {
    fn from(v: core::RevisionInfo) -> Self {
        Self { indexed_head_sha: v.indexed_head_sha, current_head_sha: v.current_head_sha, dirty: v.dirty }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct IndexStats {
    pub files: i64,
    pub chunks: i64,
    pub nodes: i64,
    pub edges: i64,
}

impl From<core::IndexStats> for IndexStats {
    fn from(v: core::IndexStats) -> Self {
        Self { files: v.files, chunks: v.chunks, nodes: v.nodes, edges: v.edges }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct IndexStatus {
    /// `never_ran | in_progress | done | failed`.
    pub state: String,
    pub usable: bool,
    pub stale: bool,
    pub stale_reasons: Vec<String>,
    pub repo_key: String,
    pub database_path: String,
    pub revision: RevisionInfo,
    pub stats: IndexStats,
}

impl From<core::IndexStatus> for IndexStatus {
    fn from(v: core::IndexStatus) -> Self {
        Self {
            state: v.state,
            usable: v.usable,
            stale: v.stale,
            stale_reasons: v.stale_reasons,
            repo_key: v.repo_key,
            database_path: v.database_path,
            revision: v.revision.into(),
            stats: v.stats.into(),
        }
    }
}
