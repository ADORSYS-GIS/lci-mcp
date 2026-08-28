//! Plain data types shared across `store` and `index_coordinator`.

#[derive(Debug, Clone)]
pub struct SymbolHit {
    pub node_id: String,
    pub label: String,
    pub source_file: String,
    pub start_line: i64,
}

#[derive(Debug, Clone)]
pub struct GraphEdgeHit {
    pub source: String,
    pub target: String,
    pub relation: String,
}

#[derive(Debug, Clone)]
pub struct ExploreResult {
    pub nodes: Vec<SymbolHit>,
    pub edges: Vec<GraphEdgeHit>,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub chunk_id: i64,
    pub node_id: Option<String>,
    pub symbol_name: Option<String>,
    pub file_path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub content: String,
    /// Cosine similarity, higher is more relevant. Never a raw distance value.
    pub score: f64,
}

#[derive(Debug, Clone)]
pub struct SearchInput {
    pub vector: Vec<f64>,
    pub limit: Option<i64>,
    pub path: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct StartIndexOptions {
    /// Identifies the embedding model/config in use. `None` means this generation is structural only.
    pub embedding_fingerprint: Option<String>,
    pub embedding_dimensions: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct IndexGenerationHandle {
    pub generation_id: String,
}

#[derive(Debug, Clone)]
pub struct EmbeddingBatchItem {
    pub id: i64,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct EmbeddingResult {
    pub id: i64,
    pub vector: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct RevisionInfo {
    pub indexed_head_sha: Option<String>,
    pub current_head_sha: String,
    pub dirty: bool,
}

#[derive(Debug, Clone)]
pub struct IndexStats {
    pub files: i64,
    pub chunks: i64,
    pub nodes: i64,
    pub edges: i64,
}

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
