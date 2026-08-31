//! Named, matchable domain errors. Constructed at the point of failure and carried inside an
//! `anyhow::Error` (via `?`/`.into()`) so every function in this crate keeps composing with the
//! plain `anyhow::Result` return type — but a caller that cares which specific condition failed can
//! `err.downcast_ref::<EngineError>()` and match on it instead of string-matching `to_string()`.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EngineError {
    #[error("an indexing lease is already held by pid {owner_pid} for generation {generation_id} (heartbeat {heartbeat_ago_ms}ms ago)")]
    LeaseHeld { owner_pid: i64, generation_id: String, heartbeat_ago_ms: i64 },

    #[error("cannot heartbeat: lease is no longer held by this owner (lost or expired)")]
    LeaseLost,

    #[error("no such generation: {0}")]
    NoSuchGeneration(String),

    #[error("cannot accept embeddings for generation {generation_id}: state is {state}")]
    NotBuilding { generation_id: String, state: String },

    #[error("cannot commit generation {generation_id}: {pending} chunks still have no embedding")]
    EmbeddingsIncomplete { generation_id: String, pending: i64 },

    #[error("cannot activate generation {generation_id}: not in BUILDING state")]
    ActivationRejected { generation_id: String },

    #[error(
        "lci-mcp: database schema version {found} is incompatible with this build (expects {expected}). \
         Delete the database file and re-index, or downgrade lci-mcp to a version that supports schema {found}."
    )]
    IncompatibleSchema { found: i64, expected: i64 },

    #[error("embedding dimension mismatch: generation expects {expected}, got {actual} for chunk {chunk_id}")]
    DimensionMismatch { expected: u32, actual: usize, chunk_id: i64 },
}
