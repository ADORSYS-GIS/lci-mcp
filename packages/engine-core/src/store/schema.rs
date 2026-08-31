//! Migration entry point. `packages/engine-core/migrations/*.sql` are the actual schema DDL,
//! embedded into the compiled binary at build time (there's no filesystem to read from once this
//! ships as a native addon) and applied forward, atomically, by `rusqlite_migration` — which tracks
//! the applied version in SQLite's own `user_version` field rather than a table of our own.

use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

use crate::error::EngineError;

const MIGRATION_STEPS: &[M<'_>] = &[M::up(include_str!("../../migrations/0001_init.sql"))];
const MIGRATIONS: Migrations<'_> = Migrations::from_slice(MIGRATION_STEPS);

/// The number of migrations in `MIGRATIONS`, kept in sync by a test below. `ensure_schema` refuses
/// to open a database recorded ahead of this rather than silently reinterpreting it.
pub const CURRENT_SCHEMA_VERSION: i64 = 1;

/// `chunk_vectors` is created once the embedding dimension is known — a `vec0` table's dimension is
/// fixed at CREATE time. Idempotent: re-running with the same dimension is a no-op via
/// `IF NOT EXISTS`; a dimension *change* requires a fresh generation anyway since generations are
/// immutable once BUILDING starts, so this never needs an ALTER path.
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

pub fn ensure_schema(conn: &mut Connection) -> anyhow::Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")?;

    let found_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if found_version > CURRENT_SCHEMA_VERSION {
        return Err(EngineError::IncompatibleSchema { found: found_version, expected: CURRENT_SCHEMA_VERSION }.into());
    }

    MIGRATIONS.to_latest(conn)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_gets_current_schema_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        ensure_schema(&mut conn).unwrap();
    }

    #[test]
    fn a_database_below_the_current_version_is_migrated_forward() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        conn.pragma_update(None, "user_version", 0).unwrap();
        ensure_schema(&mut conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn current_schema_version_matches_the_migration_count() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(MIGRATIONS.pending_migrations(&conn).unwrap() as i64, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn incompatible_future_version_is_refused() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        conn.pragma_update(None, "user_version", 999).unwrap();
        let err = ensure_schema(&mut conn).unwrap_err();
        assert_eq!(
            err.downcast_ref::<EngineError>(),
            Some(&EngineError::IncompatibleSchema { found: 999, expected: CURRENT_SCHEMA_VERSION })
        );
    }

    #[test]
    fn only_one_active_generation_allowed_at_a_time() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        let ins = "INSERT INTO index_generations \
            (id, state, created_at, head_sha, dirty, extractor_fingerprint) \
            VALUES (?1, 'ACTIVE', 0, 'sha', 0, 'fp')";
        conn.execute(ins, ["gen-a"]).unwrap();
        let err = conn.execute(ins, ["gen-b"]).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("unique"));
    }
}
