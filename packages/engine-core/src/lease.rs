//! Cross-process indexing-lease coordination. SQLite's own file locking doesn't express "who owns
//! the current BUILDING generation" — a lease row makes that explicit and inspectable.

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::EngineError;

pub const LEASE_TTL_MS: i64 = 30_000;
/// The interval callers should heartbeat at — not read on the Rust side.
#[allow(dead_code)]
pub const HEARTBEAT_INTERVAL_MS: i64 = 10_000;

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub struct LeaseInfo {
    pub generation_id: String,
    pub owner_token: String,
    pub owner_pid: i64,
    pub heartbeat_at: i64,
}

impl LeaseInfo {
    pub fn is_abandoned(&self, now: i64) -> bool {
        now - self.heartbeat_at > LEASE_TTL_MS
    }
}

pub fn current_lease(conn: &Connection) -> anyhow::Result<Option<LeaseInfo>> {
    let lease = conn
        .query_row(
            "SELECT generation_id, owner_token, owner_pid, heartbeat_at FROM index_lease WHERE id = 1",
            [],
            |row| {
                Ok(LeaseInfo {
                    generation_id: row.get(0)?,
                    owner_token: row.get(1)?,
                    owner_pid: row.get(2)?,
                    heartbeat_at: row.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(lease)
}

/// Fails if a live (non-abandoned) lease is already held for a different generation or by a
/// different owner. Only a caller re-acquiring the exact lease it already holds (same generation,
/// same owner) or taking over an abandoned lease may proceed.
pub fn ensure_acquirable(conn: &Connection, generation_id: &str, owner_token: &str) -> anyhow::Result<()> {
    let now = now_millis();
    if let Some(existing) = current_lease(conn)? {
        let is_same_holder = existing.generation_id == generation_id && existing.owner_token == owner_token;
        if !is_same_holder && !existing.is_abandoned(now) {
            return Err(EngineError::LeaseHeld {
                owner_pid: existing.owner_pid,
                generation_id: existing.generation_id,
                heartbeat_ago_ms: now - existing.heartbeat_at,
            }
            .into());
        }
    }
    Ok(())
}

/// Acquires the lease for `generation_id`, failing under the same conditions as [`ensure_acquirable`].
/// Overwrites an abandoned lease.
pub fn acquire(conn: &Connection, generation_id: &str, owner_token: &str, owner_pid: i64) -> anyhow::Result<()> {
    ensure_acquirable(conn, generation_id, owner_token)?;
    let now = now_millis();
    conn.execute(
        "INSERT INTO index_lease (id, generation_id, owner_token, owner_pid, heartbeat_at) \
         VALUES (1, ?1, ?2, ?3, ?4) \
         ON CONFLICT(id) DO UPDATE SET \
            generation_id = excluded.generation_id, \
            owner_token = excluded.owner_token, \
            owner_pid = excluded.owner_pid, \
            heartbeat_at = excluded.heartbeat_at",
        params![generation_id, owner_token, owner_pid, now],
    )?;
    Ok(())
}

pub fn heartbeat(conn: &Connection, owner_token: &str) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE index_lease SET heartbeat_at = ?1 WHERE id = 1 AND owner_token = ?2",
        params![now_millis(), owner_token],
    )?;
    if updated == 0 {
        return Err(EngineError::LeaseLost.into());
    }
    Ok(())
}

pub fn release(conn: &Connection, owner_token: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM index_lease WHERE id = 1 AND owner_token = ?1", [owner_token])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::schema::ensure_schema;

    fn seed_generation(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO index_generations (id, state, created_at, head_sha, dirty, extractor_fingerprint) \
             VALUES (?1,'BUILDING',0,'sha',0,'fp')",
            [id],
        )
        .unwrap();
    }

    #[test]
    fn second_owner_cannot_acquire_a_live_lease() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        seed_generation(&conn, "g1");
        acquire(&conn, "g1", "owner-a", 100).unwrap();
        let err = acquire(&conn, "g1", "owner-b", 200).unwrap_err();
        assert!(matches!(err.downcast_ref::<EngineError>(), Some(EngineError::LeaseHeld { .. })));
    }

    #[test]
    fn same_owner_cannot_acquire_a_live_lease_for_a_different_generation() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        seed_generation(&conn, "g1");
        seed_generation(&conn, "g2");
        acquire(&conn, "g1", "owner-a", 100).unwrap();
        let err = acquire(&conn, "g2", "owner-a", 100).unwrap_err();
        assert!(matches!(err.downcast_ref::<EngineError>(), Some(EngineError::LeaseHeld { .. })));
    }

    #[test]
    fn abandoned_lease_can_be_taken_over() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        seed_generation(&conn, "g1");
        acquire(&conn, "g1", "owner-a", 100).unwrap();
        // Force the heartbeat far enough into the past to count as abandoned.
        conn.execute(
            "UPDATE index_lease SET heartbeat_at = heartbeat_at - ?1",
            [LEASE_TTL_MS + 1000],
        )
        .unwrap();
        acquire(&conn, "g1", "owner-b", 200).unwrap();
        let lease = current_lease(&conn).unwrap().unwrap();
        assert_eq!(lease.owner_token, "owner-b");
    }

    #[test]
    fn heartbeat_from_a_stale_owner_fails() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        seed_generation(&conn, "g1");
        acquire(&conn, "g1", "owner-a", 100).unwrap();
        let err = heartbeat(&conn, "owner-b").unwrap_err();
        assert_eq!(err.downcast_ref::<EngineError>(), Some(&EngineError::LeaseLost));
    }

    #[test]
    fn release_only_removes_the_matching_owners_lease() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&mut conn).unwrap();
        seed_generation(&conn, "g1");
        acquire(&conn, "g1", "owner-a", 100).unwrap();
        release(&conn, "owner-wrong").unwrap();
        assert!(current_lease(&conn).unwrap().is_some(), "wrong-owner release must be a no-op");
        release(&conn, "owner-a").unwrap();
        assert!(current_lease(&conn).unwrap().is_none());
    }
}
