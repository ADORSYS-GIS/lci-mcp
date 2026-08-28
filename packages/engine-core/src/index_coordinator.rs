//! Orchestrates one index generation end to end: acquire the lease, extract, persist, correlate,
//! accept embedding batches, then atomically activate.

use std::path::Path;

use uuid::Uuid;

use crate::dto::{EmbeddingBatchItem, EmbeddingResult, IndexGenerationHandle, IndexStats, IndexStatus, RevisionInfo, StartIndexOptions};
use crate::store::SqliteStore;
use crate::{extractor, lease, repository};

/// Changes whenever schema or persistence logic changes, which is the only thing that can
/// invalidate a previously-built index independent of the repository itself.
fn extractor_fingerprint() -> String {
    format!("schema={};engine={}", crate::store::schema::CURRENT_SCHEMA_VERSION, env!("CARGO_PKG_VERSION"))
}

pub async fn begin_index(
    store: &SqliteStore,
    repo_root: &Path,
    owner_token: &str,
    options: &StartIndexOptions,
) -> anyhow::Result<IndexGenerationHandle> {
    let repo_info = repository::inspect(repo_root)?;
    store.set_repository_metadata(&repo_info.repo_key, &repo_info.canonical_root.to_string_lossy(), repo_info.remote_identity.as_deref())?;

    let generation_id = Uuid::new_v4().to_string();
    store.create_building_generation(
        &generation_id,
        &repo_info.head_sha,
        repo_info.dirty,
        &extractor_fingerprint(),
        options.embedding_fingerprint.as_deref(),
    )?;
    store.with_conn(|conn| lease::acquire(conn, &generation_id, owner_token, std::process::id() as i64))?;

    // Create the vector table up front when the dimension is already known, so a read before the
    // first write still works.
    if let Some(dimensions) = options.embedding_dimensions {
        store.with_conn(|conn| Ok(crate::store::schema::ensure_vector_table(conn, dimensions as u32)?))?;
    }

    let outcome = extract_and_persist(store, repo_root, &generation_id).await;
    if let Err(err) = &outcome {
        store.fail_generation(&generation_id, &err.to_string())?;
        store.with_conn(|conn| lease::release(conn, owner_token))?;
    }
    outcome?;

    Ok(IndexGenerationHandle { generation_id })
}

async fn extract_and_persist(store: &SqliteStore, repo_root: &Path, generation_id: &str) -> anyhow::Result<()> {
    let output = extractor::extract(repo_root).await?;
    store.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        crate::store::chunks::insert_chunks(&tx, generation_id, &output.chunks)?;
        crate::store::chunks::insert_graph(&tx, generation_id, &output.graph)?;
        crate::store::chunks::correlate_chunk_nodes(&tx, generation_id)?;
        tx.commit()?;
        Ok(())
    })
}

pub fn next_embedding_batch(store: &SqliteStore, generation_id: &str, limit: i64) -> anyhow::Result<Vec<EmbeddingBatchItem>> {
    let rows = store.with_conn(|conn| crate::store::chunks::pending_embedding_batch(conn, generation_id, limit))?;
    Ok(rows.into_iter().map(|(id, text)| EmbeddingBatchItem { id, text }).collect())
}

pub fn put_embeddings(store: &SqliteStore, generation_id: &str, values: &[EmbeddingResult], dimensions: i64) -> anyhow::Result<()> {
    let generation = store
        .get_generation(generation_id)?
        .ok_or_else(|| anyhow::anyhow!("no such generation: {generation_id}"))?;
    if generation.state != "BUILDING" {
        anyhow::bail!("cannot accept embeddings for generation {generation_id}: state is {}", generation.state);
    }
    let pairs: Vec<(i64, Vec<f64>)> = values.iter().map(|v| (v.id, v.vector.clone())).collect();
    store.with_conn(|conn| crate::store::vectors::put_embeddings(conn, &pairs, dimensions as u32))
}

pub fn commit_index(store: &SqliteStore, generation_id: &str, owner_token: &str) -> anyhow::Result<()> {
    let generation = store
        .get_generation(generation_id)?
        .ok_or_else(|| anyhow::anyhow!("no such generation: {generation_id}"))?;

    if generation.embedding_fingerprint.is_some() {
        let pending = store.with_conn(|conn| crate::store::chunks::all_chunk_ids_needing_embeddings(conn, generation_id))?;
        if pending > 0 {
            anyhow::bail!("cannot commit generation {generation_id}: {pending} chunks still have no embedding");
        }
    }

    store.activate_generation(generation_id)?;
    store.with_conn(|conn| lease::release(conn, owner_token))?;
    Ok(())
}

pub fn fail_index(store: &SqliteStore, generation_id: &str, reason: &str, owner_token: &str) -> anyhow::Result<()> {
    store.fail_generation(generation_id, reason)?;
    store.with_conn(|conn| lease::release(conn, owner_token))?;
    Ok(())
}

pub fn heartbeat_lease(store: &SqliteStore, owner_token: &str) -> anyhow::Result<()> {
    store.with_conn(|conn| lease::heartbeat(conn, owner_token))
}

fn generation_stats(store: &SqliteStore, generation_id: &str) -> anyhow::Result<IndexStats> {
    store.with_conn(|conn| {
        Ok(IndexStats {
            files: crate::store::chunks::count_files(conn, generation_id)?,
            chunks: crate::store::chunks::count_chunks(conn, generation_id)?,
            nodes: crate::store::chunks::count_nodes(conn, generation_id)?,
            edges: crate::store::chunks::count_edges(conn, generation_id)?,
        })
    })
}

/// State vocabulary: `never_ran | in_progress | done | failed`. A `BUILDING` generation takes
/// priority over an older `ACTIVE` one, so the prior index stays usable while a rebuild runs. A
/// `FAILED` latest attempt is only reported as `failed` when nothing has ever gone `ACTIVE` —
/// otherwise the last good index is still `done`/usable.
pub fn status(store: &SqliteStore, repo_root: &Path, database_path: &str) -> anyhow::Result<IndexStatus> {
    let repo_info = repository::inspect(repo_root)?;
    let active = store.get_active_generation()?;
    let building = store.get_most_recent_generation_in_state("BUILDING")?;

    let (state, usable, indexed_head_sha, stats, stale_extra) = if let Some(building) = &building {
        let stats = match &active {
            Some(active) => generation_stats(store, &active.id)?,
            None => IndexStats { files: 0, chunks: 0, nodes: 0, edges: 0 },
        };
        (
            "in_progress".to_string(),
            active.is_some(),
            active.as_ref().map(|g| g.head_sha.clone()),
            stats,
            if building.extractor_fingerprint != extractor_fingerprint() {
                vec!["extractor_fingerprint_changed".to_string()]
            } else {
                vec![]
            },
        )
    } else if let Some(active) = &active {
        let stats = generation_stats(store, &active.id)?;
        let extra = if active.extractor_fingerprint != extractor_fingerprint() {
            vec!["extractor_fingerprint_changed".to_string()]
        } else {
            vec![]
        };
        ("done".to_string(), true, Some(active.head_sha.clone()), stats, extra)
    } else if store.get_most_recent_generation_in_state("FAILED")?.is_some() {
        ("failed".to_string(), false, None, IndexStats { files: 0, chunks: 0, nodes: 0, edges: 0 }, vec![])
    } else {
        ("never_ran".to_string(), false, None, IndexStats { files: 0, chunks: 0, nodes: 0, edges: 0 }, vec![])
    };

    let mut stale_reasons = stale_extra;
    let stale_by_head = indexed_head_sha.as_deref().is_some_and(|s| s != repo_info.head_sha);
    if stale_by_head {
        stale_reasons.push("head_changed".to_string());
    }
    if repo_info.dirty {
        stale_reasons.push("working_tree_dirty".to_string());
    }

    Ok(IndexStatus {
        state,
        usable,
        stale: !stale_reasons.is_empty(),
        stale_reasons,
        repo_key: repo_info.repo_key,
        database_path: database_path.to_string(),
        revision: RevisionInfo {
            indexed_head_sha,
            current_head_sha: repo_info.head_sha,
            dirty: repo_info.dirty,
        },
        stats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::EmbeddingResult;
    use std::fs;

    fn fixture_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.rs"), "fn caller() { target(); }\n").unwrap();
        fs::write(dir.path().join("b.rs"), "fn target() {}\n").unwrap();
        dir
    }

    #[tokio::test]
    async fn embedding_batch_then_put_then_commit_then_search_round_trips() {
        let dir = fixture_repo();
        let store = SqliteStore::open_in_memory().unwrap();
        let options = StartIndexOptions {
            embedding_fingerprint: Some("fake-model-v1".to_string()),
            embedding_dimensions: Some(4),
        };
        let handle = begin_index(&store, dir.path(), "owner-a", &options).await.unwrap();

        let batch = next_embedding_batch(&store, &handle.generation_id, 100).unwrap();
        assert!(!batch.is_empty(), "expected at least one chunk needing embeddings");

        let values: Vec<EmbeddingResult> = batch
            .iter()
            .enumerate()
            .map(|(i, item)| EmbeddingResult { id: item.id, vector: vec![(i % 2) as f64, ((i + 1) % 2) as f64, 0.0, 0.0] })
            .collect();
        put_embeddings(&store, &handle.generation_id, &values, 4).unwrap();

        let remaining = next_embedding_batch(&store, &handle.generation_id, 100).unwrap();
        assert!(remaining.is_empty(), "every chunk should have a vector now");

        commit_index(&store, &handle.generation_id, "owner-a").unwrap();
        assert!(store.get_active_generation().unwrap().is_some());

        let hits = store
            .with_conn(|conn| {
                crate::store::vectors::search(
                    conn,
                    &handle.generation_id,
                    &crate::dto::SearchInput { vector: vec![1.0, 0.0, 0.0, 0.0], limit: Some(5), path: None, language: None },
                )
            })
            .unwrap();
        assert!(!hits.is_empty());
    }

    #[tokio::test]
    async fn next_embedding_batch_works_when_dimensions_were_never_declared_up_front() {
        let dir = fixture_repo();
        let store = SqliteStore::open_in_memory().unwrap();
        let options = StartIndexOptions { embedding_fingerprint: Some("fp".to_string()), embedding_dimensions: None };
        let handle = begin_index(&store, dir.path(), "owner-a", &options).await.unwrap();

        let batch = next_embedding_batch(&store, &handle.generation_id, 100).unwrap();
        assert!(!batch.is_empty());

        let values: Vec<EmbeddingResult> = batch.iter().map(|b| EmbeddingResult { id: b.id, vector: vec![1.0, 0.0, 0.0] }).collect();
        put_embeddings(&store, &handle.generation_id, &values, 3).unwrap();

        let remaining = next_embedding_batch(&store, &handle.generation_id, 100).unwrap();
        assert!(remaining.is_empty());
    }

    #[tokio::test]
    async fn commit_without_embeddings_configured_never_requires_them() {
        let dir = fixture_repo();
        let store = SqliteStore::open_in_memory().unwrap();
        let handle = begin_index(&store, dir.path(), "owner-a", &StartIndexOptions::default()).await.unwrap();
        commit_index(&store, &handle.generation_id, "owner-a").unwrap();
        assert!(store.get_active_generation().unwrap().is_some());
    }

    #[tokio::test]
    async fn status_reports_in_progress_while_a_generation_is_building() {
        let dir = fixture_repo();
        let store = SqliteStore::open_in_memory().unwrap();
        let options = StartIndexOptions { embedding_fingerprint: Some("fp".to_string()), embedding_dimensions: Some(2) };
        let handle = begin_index(&store, dir.path(), "owner-a", &options).await.unwrap();

        // Not committed yet -> a BUILDING generation exists, no ACTIVE one yet.
        let s = status(&store, dir.path(), "db.sqlite").unwrap();
        assert_eq!(s.state, "in_progress");
        assert!(!s.usable, "no ACTIVE generation exists yet, so nothing is usable");

        let batch = next_embedding_batch(&store, &handle.generation_id, 100).unwrap();
        let values: Vec<EmbeddingResult> = batch.iter().map(|b| EmbeddingResult { id: b.id, vector: vec![1.0, 0.0] }).collect();
        put_embeddings(&store, &handle.generation_id, &values, 2).unwrap();
        commit_index(&store, &handle.generation_id, "owner-a").unwrap();

        let s2 = status(&store, dir.path(), "db.sqlite").unwrap();
        assert_eq!(s2.state, "done");
        assert!(s2.usable);
    }

    #[tokio::test]
    async fn status_reports_in_progress_with_usable_true_when_an_older_generation_is_still_active() {
        let dir = fixture_repo();
        let store = SqliteStore::open_in_memory().unwrap();
        let first = begin_index(&store, dir.path(), "owner-a", &StartIndexOptions::default()).await.unwrap();
        commit_index(&store, &first.generation_id, "owner-a").unwrap();

        // Start a second (structural-only) generation but don't commit it.
        store.create_building_generation("g2", "sha2", false, "fp", None).unwrap();
        store.with_conn(|conn| lease::acquire(conn, "g2", "owner-a", 1)).unwrap();

        let s = status(&store, dir.path(), "db.sqlite").unwrap();
        assert_eq!(s.state, "in_progress");
        assert!(s.usable, "the prior ACTIVE generation must still be usable while a rebuild is in flight");
    }

    #[tokio::test]
    async fn status_reports_failed_only_when_no_generation_has_ever_gone_active() {
        let dir = fixture_repo();
        let store = SqliteStore::open_in_memory().unwrap();
        let handle = begin_index(&store, dir.path(), "owner-a", &StartIndexOptions::default()).await.unwrap();
        fail_index(&store, &handle.generation_id, "boom", "owner-a").unwrap();

        let s = status(&store, dir.path(), "db.sqlite").unwrap();
        assert_eq!(s.state, "failed");
        assert!(!s.usable);
    }

    #[tokio::test]
    async fn commit_with_embeddings_configured_but_incomplete_is_rejected() {
        let dir = fixture_repo();
        let store = SqliteStore::open_in_memory().unwrap();
        let options = StartIndexOptions { embedding_fingerprint: Some("fp".to_string()), embedding_dimensions: Some(2) };
        let handle = begin_index(&store, dir.path(), "owner-a", &options).await.unwrap();
        let err = commit_index(&store, &handle.generation_id, "owner-a").unwrap_err();
        assert!(err.to_string().contains("still have no embedding"));
    }
}
