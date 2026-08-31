//! Pure-Rust code-intelligence engine — extraction orchestration, SQLite/sqlite-vec persistence, and
//! the graph/vector query services. No N-API here; `engine/` wraps this crate in a thin `#[napi]`
//! boundary. See this crate's `Cargo.toml` for why that split exists.

pub mod dto;
pub mod error;
pub mod extractor;
pub mod index_coordinator;
pub mod lease;
pub mod repository;
pub mod store;

pub use dto::*;
pub use error::EngineError;
