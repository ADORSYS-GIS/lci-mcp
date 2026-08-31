pub mod chunks;
pub mod graph;
pub mod schema;
pub mod vectors;

use std::path::Path;
use std::sync::{Mutex, Once};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::EngineError;

static REGISTER_VEC_EXTENSION: Once = Once::new();

fn register_vector_extension() {
    REGISTER_VEC_EXTENSION.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

#[derive(Debug, Clone)]
pub struct GenerationRow {
    pub id: String,
    pub state: String,
    pub head_sha: String,
    /// Recorded for diagnostics/tests; current staleness decisions re-inspect the working tree live
    /// (`index_coordinator::status`) rather than trusting this snapshot.
    #[allow(dead_code)]
    pub dirty: bool,
    pub extractor_fingerprint: String,
    pub embedding_fingerprint: Option<String>,
    #[allow(dead_code)]
    pub failure_reason: Option<String>,
}

/// Owns the single SQLite connection for one repository's index database. Guarded by a `Mutex`
/// because `Connection` is `Send` but not `Sync`, and callers run against it from blocking tasks.
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(database_path: &Path) -> anyhow::Result<Self> {
        register_vector_extension();
        if let Some(parent) = database_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(database_path)?;
        schema::ensure_schema(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        register_vector_extension();
        let conn = Connection::open_in_memory()?;
        schema::ensure_schema(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> anyhow::Result<T>) -> anyhow::Result<T> {
        let conn = self.conn.lock().expect("sqlite connection mutex poisoned");
        f(&conn)
    }

    pub fn set_repository_metadata(&self, repo_key: &str, canonical_root: &str, remote_identity: Option<&str>) -> anyhow::Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO repository_metadata (id, repo_key, canonical_root, remote_identity) \
                 VALUES (1, ?1, ?2, ?3) \
                 ON CONFLICT(id) DO UPDATE SET repo_key = excluded.repo_key, \
                    canonical_root = excluded.canonical_root, remote_identity = excluded.remote_identity",
                params![repo_key, canonical_root, remote_identity],
            )?;
            Ok(())
        })
    }

    pub fn create_building_generation(
        &self,
        id: &str,
        head_sha: &str,
        dirty: bool,
        extractor_fingerprint: &str,
        embedding_fingerprint: Option<&str>,
    ) -> anyhow::Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO index_generations \
                    (id, state, created_at, head_sha, dirty, extractor_fingerprint, embedding_fingerprint) \
                 VALUES (?1, 'BUILDING', ?2, ?3, ?4, ?5, ?6)",
                params![id, crate::lease::now_millis(), head_sha, dirty as i64, extractor_fingerprint, embedding_fingerprint],
            )?;
            Ok(())
        })
    }

    /// Atomically checks that no other live lease is held, creates the new `BUILDING` generation, and
    /// acquires the lease for it, all in one transaction — so two overlapping calls can't both observe
    /// "no live lease" and race each other into existence.
    #[allow(clippy::too_many_arguments)]
    pub fn begin_generation(
        &self,
        id: &str,
        head_sha: &str,
        dirty: bool,
        extractor_fingerprint: &str,
        embedding_fingerprint: Option<&str>,
        owner_token: &str,
        owner_pid: i64,
    ) -> anyhow::Result<()> {
        self.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            crate::lease::ensure_acquirable(&tx, id, owner_token)?;
            tx.execute(
                "INSERT INTO index_generations \
                    (id, state, created_at, head_sha, dirty, extractor_fingerprint, embedding_fingerprint) \
                 VALUES (?1, 'BUILDING', ?2, ?3, ?4, ?5, ?6)",
                params![id, crate::lease::now_millis(), head_sha, dirty as i64, extractor_fingerprint, embedding_fingerprint],
            )?;
            crate::lease::acquire(&tx, id, owner_token, owner_pid)?;
            tx.commit()?;
            Ok(())
        })
    }

    /// Atomically flips the previous `ACTIVE` generation to `OBSOLETE` (if any) and this one to
    /// `ACTIVE` — one transaction, so a reader never observes zero active generations.
    pub fn activate_generation(&self, id: &str) -> anyhow::Result<()> {
        self.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute("UPDATE index_generations SET state = 'OBSOLETE' WHERE state = 'ACTIVE'", [])?;
            let updated = tx.execute(
                "UPDATE index_generations SET state = 'ACTIVE', activated_at = ?2 WHERE id = ?1 AND state = 'BUILDING'",
                params![id, crate::lease::now_millis()],
            )?;
            if updated == 0 {
                return Err(EngineError::ActivationRejected { generation_id: id.to_string() }.into());
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn fail_generation(&self, id: &str, reason: &str) -> anyhow::Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE index_generations SET state = 'FAILED', failure_reason = ?2 WHERE id = ?1",
                params![id, reason],
            )?;
            Ok(())
        })
    }

    /// Startup recovery: any `BUILDING` generation whose lease is missing or abandoned did not
    /// survive its owning process — mark it `ABANDONED` and leave the previously `ACTIVE`
    /// generation untouched.
    pub fn recover_abandoned_generations(&self) -> anyhow::Result<usize> {
        self.with_conn(|conn| {
            let lease = crate::lease::current_lease(conn)?;
            let now = crate::lease::now_millis();
            let live_generation_id = match &lease {
                Some(l) if !l.is_abandoned(now) => Some(l.generation_id.clone()),
                _ => None,
            };
            let updated = match live_generation_id {
                Some(id) => conn.execute(
                    "UPDATE index_generations SET state = 'ABANDONED' WHERE state = 'BUILDING' AND id != ?1",
                    [id],
                )?,
                None => conn.execute("UPDATE index_generations SET state = 'ABANDONED' WHERE state = 'BUILDING'", [])?,
            };
            Ok(updated)
        })
    }

    pub fn get_active_generation(&self) -> anyhow::Result<Option<GenerationRow>> {
        self.get_generation_by(None)
    }

    pub fn get_generation(&self, id: &str) -> anyhow::Result<Option<GenerationRow>> {
        self.get_generation_by(Some(id))
    }

    /// Most recent generation in `state`, if any — used by `index_coordinator::status` to detect an
    /// in-flight `BUILDING` generation (which may coexist with an older `ACTIVE` one) and to find the
    /// latest `FAILED` attempt when no generation has ever gone `ACTIVE`.
    pub fn get_most_recent_generation_in_state(&self, state: &str) -> anyhow::Result<Option<GenerationRow>> {
        self.with_conn(|conn| {
            let row = conn
                .query_row(
                    "SELECT id, state, head_sha, dirty, extractor_fingerprint, embedding_fingerprint, failure_reason \
                     FROM index_generations WHERE state = ?1 ORDER BY created_at DESC LIMIT 1",
                    [state],
                    row_to_generation,
                )
                .optional()?;
            Ok(row)
        })
    }

    fn get_generation_by(&self, id: Option<&str>) -> anyhow::Result<Option<GenerationRow>> {
        self.with_conn(|conn| {
            let row = match id {
                Some(id) => conn
                    .query_row(
                        "SELECT id, state, head_sha, dirty, extractor_fingerprint, embedding_fingerprint, failure_reason \
                         FROM index_generations WHERE id = ?1",
                        [id],
                        row_to_generation,
                    )
                    .optional()?,
                None => conn
                    .query_row(
                        "SELECT id, state, head_sha, dirty, extractor_fingerprint, embedding_fingerprint, failure_reason \
                         FROM index_generations WHERE state = 'ACTIVE'",
                        [],
                        row_to_generation,
                    )
                    .optional()?,
            };
            Ok(row)
        })
    }
}

fn row_to_generation(row: &rusqlite::Row) -> rusqlite::Result<GenerationRow> {
    Ok(GenerationRow {
        id: row.get(0)?,
        state: row.get(1)?,
        head_sha: row.get(2)?,
        dirty: row.get::<_, i64>(3)? != 0,
        extractor_fingerprint: row.get(4)?,
        embedding_fingerprint: row.get(5)?,
        failure_reason: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activating_a_generation_obsoletes_the_previous_active_one() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.create_building_generation("g1", "sha1", false, "fp", None).unwrap();
        store.activate_generation("g1").unwrap();
        store.create_building_generation("g2", "sha2", false, "fp", None).unwrap();
        store.activate_generation("g2").unwrap();

        let active = store.get_active_generation().unwrap().unwrap();
        assert_eq!(active.id, "g2");
        let g1 = store.get_generation("g1").unwrap().unwrap();
        assert_eq!(g1.state, "OBSOLETE");
    }

    #[test]
    fn failed_generation_does_not_disturb_the_active_one() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.create_building_generation("g1", "sha1", false, "fp", None).unwrap();
        store.activate_generation("g1").unwrap();
        store.create_building_generation("g2", "sha2", false, "fp", None).unwrap();
        store.fail_generation("g2", "embedding provider down").unwrap();

        let active = store.get_active_generation().unwrap().unwrap();
        assert_eq!(active.id, "g1", "a failed rebuild must leave the last good index queryable");
        let g2 = store.get_generation("g2").unwrap().unwrap();
        assert_eq!(g2.state, "FAILED");
        assert_eq!(g2.failure_reason.as_deref(), Some("embedding provider down"));
    }

    #[test]
    fn recovery_marks_building_generations_with_no_live_lease_as_abandoned() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.create_building_generation("g1", "sha1", false, "fp", None).unwrap();
        // No lease acquired at all -> simulates a crash before the lease row was even written.
        let recovered = store.recover_abandoned_generations().unwrap();
        assert_eq!(recovered, 1);
        let g1 = store.get_generation("g1").unwrap().unwrap();
        assert_eq!(g1.state, "ABANDONED");
    }

    #[test]
    fn recovery_leaves_a_generation_with_a_live_lease_alone() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.create_building_generation("g1", "sha1", false, "fp", None).unwrap();
        store.with_conn(|conn| crate::lease::acquire(conn, "g1", "owner-a", 42)).unwrap();
        let recovered = store.recover_abandoned_generations().unwrap();
        assert_eq!(recovered, 0);
        let g1 = store.get_generation("g1").unwrap().unwrap();
        assert_eq!(g1.state, "BUILDING");
    }
}
