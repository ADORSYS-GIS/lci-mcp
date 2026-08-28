//! DDL and migration entry point.

use rusqlite::Connection;

/// Bumped whenever the DDL below changes shape. `ensure_schema` is the only place allowed to read or
/// write this — every other module treats the schema as already-correct.
pub const CURRENT_SCHEMA_VERSION: i64 = 1;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repository_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    repo_key TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    remote_identity TEXT
);

CREATE TABLE IF NOT EXISTS index_generations (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('BUILDING','ACTIVE','OBSOLETE','FAILED','ABANDONED')),
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    head_sha TEXT NOT NULL,
    dirty INTEGER NOT NULL,
    extractor_fingerprint TEXT NOT NULL,
    embedding_fingerprint TEXT,
    failure_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_one_active_generation
    ON index_generations(state) WHERE state = 'ACTIVE';

CREATE TABLE IF NOT EXISTS index_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    owner_token TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    file_path TEXT NOT NULL,
    language TEXT,
    content_hash TEXT,
    PRIMARY KEY (generation_id, file_path)
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    symbol_name TEXT,
    node_id TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    embed_input TEXT,
    content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_chunks_generation_path ON chunks(generation_id, file_path);
CREATE INDEX IF NOT EXISTS ix_chunks_generation_node ON chunks(generation_id, node_id);

CREATE TABLE IF NOT EXISTS graph_nodes (
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    node_id TEXT NOT NULL,
    label TEXT NOT NULL,
    source_file TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    PRIMARY KEY (generation_id, node_id)
);

CREATE TABLE IF NOT EXISTS graph_edges (
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('contains','method','calls'))
);
CREATE INDEX IF NOT EXISTS ix_edges_source ON graph_edges(generation_id, source, relation);
CREATE INDEX IF NOT EXISTS ix_edges_target ON graph_edges(generation_id, target, relation);
"#;

/// `chunk_vectors` is created lazily, once the embedding dimension is known (Phase 3 / §4.2 note:
/// a `vec0` table's dimension is fixed at CREATE time). Idempotent: re-running with the same
/// dimension is a no-op via `IF NOT EXISTS`; a dimension *change* requires a fresh generation anyway
/// since generations are immutable once BUILDING starts, so this never needs an ALTER path.
pub fn ensure_vector_table(conn: &Connection, dimensions: u32) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(\
                chunk_id INTEGER PRIMARY KEY, \
                embedding FLOAT[{dimensions}])"
        ),
        [],
    )?;
    Ok(())
}

pub fn ensure_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")?;

    let found_version: Option<i64> = conn
        .query_row("SELECT schema_version FROM schema_metadata WHERE id = 1", [], |r| r.get(0))
        .ok();

    match found_version {
        None => {
            // Fresh database (schema_metadata table may not even exist yet).
            conn.execute_batch(DDL)?;
            conn.execute(
                "INSERT INTO schema_metadata (id, schema_version) VALUES (1, ?1)",
                [CURRENT_SCHEMA_VERSION],
            )?;
        }
        Some(v) if v == CURRENT_SCHEMA_VERSION => {
            // Already at the current version — DDL is idempotent (IF NOT EXISTS everywhere) so this
            // still runs it, cheaply, to heal a database that has the metadata row but is missing an
            // index/table from an interrupted first run.
            conn.execute_batch(DDL)?;
        }
        Some(v) => {
            anyhow::bail!(
                "lci-mcp: database schema version {v} is incompatible with this build \
                 (expects {CURRENT_SCHEMA_VERSION}). Delete the database file and re-index, or \
                 downgrade lci-mcp to a version that supports schema {v}."
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_gets_current_schema_version() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let v: i64 = conn
            .query_row("SELECT schema_version FROM schema_metadata WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
    }

    #[test]
    fn incompatible_future_version_is_refused() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("UPDATE schema_metadata SET schema_version = 999", []).unwrap();
        let err = ensure_schema(&conn).unwrap_err();
        assert!(err.to_string().contains("incompatible"));
    }

    #[test]
    fn only_one_active_generation_allowed_at_a_time() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let ins = "INSERT INTO index_generations \
            (id, state, created_at, head_sha, dirty, extractor_fingerprint) \
            VALUES (?1, 'ACTIVE', 0, 'sha', 0, 'fp')";
        conn.execute(ins, ["gen-a"]).unwrap();
        let err = conn.execute(ins, ["gen-b"]).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("unique"));
    }
}
