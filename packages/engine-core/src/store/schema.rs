//! Migration entry point. Each `migrations/NNNN_name.sql` file is one forward-only step, embedded
//! into the compiled binary at build time (there's no filesystem to read from once this ships as a
//! native addon), and applied in order up to `CURRENT_SCHEMA_VERSION`.

use rusqlite::Connection;

/// Ordered by version. Every statement in a migration file must be safe to re-run (`IF NOT EXISTS`
/// etc.) — a migration that fails partway through never commits its version bump (see
/// `ensure_schema`), so the next run retries the same file from scratch rather than resuming
/// mid-way.
const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../../migrations/0001_init.sql"))];

/// The latest version any migration in `MIGRATIONS` applies. `ensure_schema` is the only place
/// allowed to read or write a database's own recorded version — every other module treats the
/// schema as already-correct.
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

pub fn ensure_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")?;

    // `schema_metadata` may not exist yet on a fresh database — any error here (missing table
    // included) means "nothing applied so far".
    let found_version: i64 = conn
        .query_row("SELECT schema_version FROM schema_metadata WHERE id = 1", [], |r| r.get(0))
        .ok()
        .unwrap_or(0);

    if found_version > CURRENT_SCHEMA_VERSION {
        anyhow::bail!(
            "lci-mcp: database schema version {found_version} is incompatible with this build \
             (expects {CURRENT_SCHEMA_VERSION}). Delete the database file and re-index, or \
             downgrade lci-mcp to a version that supports schema {found_version}."
        );
    }

    for (version, sql) in MIGRATIONS {
        if *version <= found_version {
            continue;
        }
        // DDL and version bump commit together, so a crash mid-migration leaves the recorded
        // version untouched and the next run retries this same file from scratch.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_metadata (id, schema_version) VALUES (1, ?1) \
             ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version",
            [version],
        )?;
        tx.commit()?;
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
    fn a_database_below_the_current_version_is_migrated_forward() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("UPDATE schema_metadata SET schema_version = 0", []).unwrap();
        ensure_schema(&conn).unwrap();
        let v: i64 = conn
            .query_row("SELECT schema_version FROM schema_metadata WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn current_schema_version_matches_the_last_migration() {
        assert_eq!(MIGRATIONS.last().unwrap().0, CURRENT_SCHEMA_VERSION);
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
