//! Vector storage and search. `score` is always `1 - distance` (cosine similarity, higher is more
//! relevant), never the raw sqlite-vec distance.

use rusqlite::{params, Connection};

use crate::dto::{SearchHit, SearchInput};

fn vector_literal(vector: &[f64]) -> String {
    let parts: Vec<String> = vector.iter().map(|v| v.to_string()).collect();
    format!("[{}]", parts.join(","))
}

pub fn put_embeddings(
    conn: &Connection,
    values: &[(i64, Vec<f64>)],
    dimensions: u32,
) -> anyhow::Result<()> {
    crate::store::schema::ensure_vector_table(conn, dimensions)?;
    let mut stmt = conn.prepare("INSERT OR REPLACE INTO chunk_vectors (chunk_id, embedding) VALUES (?1, ?2)")?;
    for (chunk_id, vector) in values {
        if vector.len() != dimensions as usize {
            anyhow::bail!(
                "embedding dimension mismatch: generation expects {dimensions}, got {} for chunk {chunk_id}",
                vector.len()
            );
        }
        stmt.execute(params![chunk_id, vector_literal(vector)])?;
    }
    Ok(())
}

pub fn search(conn: &Connection, generation_id: &str, input: &SearchInput) -> anyhow::Result<Vec<SearchHit>> {
    let limit = input.limit.unwrap_or(10).clamp(1, 200);
    let dimensions = input.vector.len();

    // No vector table yet -> empty result, not an error: a structural-only index is legitimate.
    let table_exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vectors'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !table_exists {
        return Ok(vec![]);
    }

    let mut sql = String::from(
        "SELECT c.id, c.node_id, c.symbol_name, c.file_path, c.start_line, c.end_line, c.content, v.distance \
         FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id \
         WHERE c.generation_id = ?1 AND v.embedding MATCH ?2 AND k = ?3",
    );
    let mut bind: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(generation_id.to_string()),
        Box::new(vector_literal(&input.vector)),
        Box::new(limit),
    ];
    if let Some(path) = &input.path {
        sql.push_str(" AND c.file_path LIKE '%' || ?4 || '%'");
        bind.push(Box::new(path.clone()));
    }
    if let Some(language) = &input.language {
        sql.push_str(&format!(" AND c.language = ?{}", bind.len() + 1));
        bind.push(Box::new(language.clone()));
    }
    sql.push_str(" ORDER BY v.distance LIMIT ?3");
    let _ = dimensions;

    let mut stmt = conn.prepare(&sql)?;
    let bind_refs: Vec<&dyn rusqlite::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(bind_refs.as_slice(), |row| {
            let distance: f64 = row.get(7)?;
            Ok(SearchHit {
                chunk_id: row.get(0)?,
                node_id: row.get(1)?,
                symbol_name: row.get(2)?,
                file_path: row.get(3)?,
                start_line: row.get(4)?,
                end_line: row.get(5)?,
                content: row.get(6)?,
                score: 1.0 - distance,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::schema::ensure_schema;

    fn seed_chunk(conn: &Connection, id: i64, file: &str, content: &str) {
        conn.execute(
            "INSERT INTO chunks (id, generation_id, file_path, language, chunk_type, start_line, end_line, content, content_hash) \
             VALUES (?1, 'g1', ?2, 'rust', 'function', 1, 2, ?3, 'h')",
            params![id, file, content],
        )
        .unwrap();
    }

    #[test]
    fn search_ranks_closest_vector_first_and_scores_are_similarity_not_distance() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO index_generations (id, state, created_at, head_sha, dirty, extractor_fingerprint) \
             VALUES ('g1','ACTIVE',0,'sha',0,'fp')",
            [],
        )
        .unwrap();
        seed_chunk(&conn, 1, "close.rs", "close");
        seed_chunk(&conn, 2, "far.rs", "far");

        put_embeddings(&conn, &[(1, vec![1.0, 0.0]), (2, vec![0.0, 1.0])], 2).unwrap();

        let input = SearchInput { vector: vec![1.0, 0.0], limit: Some(5), path: None, language: None };
        let hits = search(&conn, "g1", &input).unwrap();
        assert_eq!(hits[0].file_path, "close.rs");
        assert!(hits[0].score > hits[1].score);
        assert!(hits[0].score > 0.9, "near-identical vectors must score near 1.0, got {}", hits[0].score);
    }

    #[test]
    fn search_before_any_embeddings_returns_empty_not_error() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let input = SearchInput { vector: vec![1.0, 0.0], limit: None, path: None, language: None };
        let hits = search(&conn, "g1", &input).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn dimension_mismatch_is_rejected_loudly() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let err = put_embeddings(&conn, &[(1, vec![1.0, 2.0, 3.0])], 2).unwrap_err();
        assert!(err.to_string().contains("dimension mismatch"));
    }
}
