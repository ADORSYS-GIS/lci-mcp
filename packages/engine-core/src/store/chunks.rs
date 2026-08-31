//! Persisting extraction output: chunks, graph nodes/edges, and the chunk-to-node correlation.

use lci_codegraph::{Chunk, Graph};
use rusqlite::{params, Connection, OptionalExtension};

fn content_hash(content: &str) -> String {
    blake3::hash(content.as_bytes()).to_hex().to_string()
}

pub fn insert_chunks(conn: &Connection, generation_id: &str, chunks: &[Chunk]) -> anyhow::Result<usize> {
    let mut stmt = conn.prepare(
        "INSERT INTO chunks \
            (generation_id, file_path, language, chunk_type, symbol_name, start_line, end_line, \
             content, embed_input, content_hash) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for chunk in chunks {
        // embed_input mirrors raw content for now; the embedding client is responsible for its own
        // truncation before sending.
        let embed_input = chunk.content.clone();
        stmt.execute(params![
            generation_id,
            chunk.file_path,
            chunk.language,
            chunk.chunk_type,
            chunk.symbol_name,
            chunk.start_line,
            chunk.end_line,
            chunk.content,
            embed_input,
            content_hash(&chunk.content),
        ])?;
    }
    Ok(chunks.len())
}

pub fn insert_graph(conn: &Connection, generation_id: &str, graph: &Graph) -> anyhow::Result<(usize, usize)> {
    {
        let mut stmt = conn.prepare(
            "INSERT INTO graph_nodes (generation_id, node_id, label, source_file, start_line) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for node in &graph.nodes {
            stmt.execute(params![generation_id, node.node_id, node.label, node.source_file, node.start_line])?;
        }
    }
    {
        let mut stmt = conn.prepare(
            "INSERT INTO graph_edges (generation_id, source, target, relation) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for edge in &graph.edges {
            stmt.execute(params![generation_id, edge.source, edge.target, edge.relation])?;
        }
    }
    Ok((graph.nodes.len(), graph.edges.len()))
}

/// Correlates each persisted chunk to its graph node by `(file_path, start_line + 1)` — chunk lines
/// are 0-based, graph node lines are 1-based. Window/PDF chunks correlate to nothing and keep
/// `node_id = NULL`.
pub fn correlate_chunk_nodes(conn: &Connection, generation_id: &str) -> anyhow::Result<usize> {
    let updated = conn.execute(
        "UPDATE chunks SET node_id = ( \
            SELECT node_id FROM graph_nodes \
            WHERE graph_nodes.generation_id = chunks.generation_id \
              AND graph_nodes.source_file = chunks.file_path \
              AND graph_nodes.start_line = chunks.start_line + 1 \
            LIMIT 1 \
         ) WHERE generation_id = ?1",
        [generation_id],
    )?;
    Ok(updated)
}

pub fn count_chunks(conn: &Connection, generation_id: &str) -> anyhow::Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE generation_id = ?1",
        [generation_id],
        |r| r.get(0),
    )?)
}

pub fn count_nodes(conn: &Connection, generation_id: &str) -> anyhow::Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM graph_nodes WHERE generation_id = ?1",
        [generation_id],
        |r| r.get(0),
    )?)
}

pub fn count_edges(conn: &Connection, generation_id: &str) -> anyhow::Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM graph_edges WHERE generation_id = ?1",
        [generation_id],
        |r| r.get(0),
    )?)
}

pub fn count_files(conn: &Connection, generation_id: &str) -> anyhow::Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(DISTINCT file_path) FROM chunks WHERE generation_id = ?1",
        [generation_id],
        |r| r.get(0),
    )?)
}

/// `chunk_vectors` only exists once something has called `ensure_vector_table` (either eagerly in
/// `begin_index`, when the caller already declared `embeddingDimensions`, or lazily inside the first
/// `put_embeddings` call). A caller that omits `embeddingDimensions` up front must still be able to
/// call `nextEmbeddingBatch` *before* the table exists — this guard is what makes that safe, mirroring
/// the identical guard in `vectors::search`.
fn vector_table_exists(conn: &Connection) -> anyhow::Result<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vectors'", [], |_| Ok(true))
        .optional()?
        .unwrap_or(false))
}

/// Chunks whose `embed_input` is set but which have no row in `chunk_vectors` yet, for the active
/// `generation_id` — the source of `nextEmbeddingBatch`.
pub fn pending_embedding_batch(
    conn: &Connection,
    generation_id: &str,
    limit: i64,
) -> anyhow::Result<Vec<(i64, String)>> {
    if !vector_table_exists(conn)? {
        let mut stmt = conn.prepare(
            "SELECT id, embed_input FROM chunks WHERE generation_id = ?1 AND embed_input IS NOT NULL ORDER BY id LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![generation_id, limit], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(rows);
    }
    let mut stmt = conn.prepare(
        "SELECT c.id, c.embed_input FROM chunks c \
         LEFT JOIN chunk_vectors v ON v.chunk_id = c.id \
         WHERE c.generation_id = ?1 AND c.embed_input IS NOT NULL AND v.chunk_id IS NULL \
         ORDER BY c.id LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![generation_id, limit], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn all_chunk_ids_needing_embeddings(conn: &Connection, generation_id: &str) -> anyhow::Result<i64> {
    if !vector_table_exists(conn)? {
        return Ok(conn.query_row(
            "SELECT COUNT(*) FROM chunks WHERE generation_id = ?1 AND embed_input IS NOT NULL",
            [generation_id],
            |r| r.get(0),
        )?);
    }
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM chunks c \
         LEFT JOIN chunk_vectors v ON v.chunk_id = c.id \
         WHERE c.generation_id = ?1 AND c.embed_input IS NOT NULL AND v.chunk_id IS NULL",
        [generation_id],
        |r| r.get(0),
    )?)
}
