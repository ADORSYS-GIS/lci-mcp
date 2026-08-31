//! Symbol lookup and call-graph traversal, scoped to one index generation.

use rusqlite::{params, Connection};

use crate::dto::{GraphEdgeHit, ExploreResult, SymbolHit};

/// Hard cap enforced regardless of client-requested value.
const MAX_LIMIT: i64 = 200;
const MAX_DEPTH: i64 = 3;

fn clamp_limit(limit: Option<i64>, default: i64) -> i64 {
    limit.unwrap_or(default).clamp(1, MAX_LIMIT)
}

fn clamp_depth(depth: Option<i64>, default: i64) -> i64 {
    depth.unwrap_or(default).clamp(0, MAX_DEPTH)
}

fn row_to_hit(row: &rusqlite::Row) -> rusqlite::Result<SymbolHit> {
    Ok(SymbolHit {
        node_id: row.get(0)?,
        label: row.get(1)?,
        source_file: row.get(2)?,
        start_line: row.get(3)?,
    })
}

pub fn find_symbol(
    conn: &Connection,
    generation_id: &str,
    term: &str,
    limit: Option<i64>,
) -> anyhow::Result<Vec<SymbolHit>> {
    let limit = clamp_limit(limit, 20);
    let mut stmt = conn.prepare(
        "SELECT node_id, label, source_file, start_line FROM graph_nodes \
         WHERE generation_id = ?1 \
           AND (label LIKE '%' || ?2 || '%' COLLATE NOCASE \
                OR node_id LIKE '%' || ?2 || '%' COLLATE NOCASE \
                OR source_file LIKE '%' || ?2 || '%' COLLATE NOCASE) \
         ORDER BY source_file, start_line \
         LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![generation_id, term, limit], row_to_hit)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_callers(
    conn: &Connection,
    generation_id: &str,
    node_id: &str,
    limit: Option<i64>,
) -> anyhow::Result<Vec<SymbolHit>> {
    let limit = clamp_limit(limit, 50);
    let mut stmt = conn.prepare(
        "SELECT n.node_id, n.label, n.source_file, n.start_line \
         FROM graph_edges e JOIN graph_nodes n \
           ON n.generation_id = e.generation_id AND n.node_id = e.source \
         WHERE e.generation_id = ?1 AND e.relation = 'calls' AND e.target = ?2 \
         ORDER BY n.source_file, n.start_line \
         LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![generation_id, node_id, limit], row_to_hit)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_callees(
    conn: &Connection,
    generation_id: &str,
    node_id: &str,
    limit: Option<i64>,
) -> anyhow::Result<Vec<SymbolHit>> {
    let limit = clamp_limit(limit, 50);
    let mut stmt = conn.prepare(
        "SELECT n.node_id, n.label, n.source_file, n.start_line \
         FROM graph_edges e JOIN graph_nodes n \
           ON n.generation_id = e.generation_id AND n.node_id = e.target \
         WHERE e.generation_id = ?1 AND e.relation = 'calls' AND e.source = ?2 \
         ORDER BY n.source_file, n.start_line \
         LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![generation_id, node_id, limit], row_to_hit)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Bounded, cycle-safe, bidirectional neighborhood. `UNION` (not `UNION ALL`) is load-bearing: it
/// both dedups and is what makes recursion terminate on a cycle.
pub fn explore_symbol(
    conn: &Connection,
    generation_id: &str,
    node_id: &str,
    callers_depth: Option<i64>,
    callees_depth: Option<i64>,
    limit: Option<i64>,
) -> anyhow::Result<ExploreResult> {
    let limit = clamp_limit(limit, 50);
    let callers_depth = clamp_depth(callers_depth, 1);
    let callees_depth = clamp_depth(callees_depth, 1);
    let max_depth = callers_depth.max(callees_depth);

    let mut stmt = conn.prepare(
        "WITH RECURSIVE frontier(node_id, depth) AS ( \
            SELECT ?1, 0 \
            UNION \
            SELECT e.target, f.depth + 1 FROM graph_edges e \
              JOIN frontier f ON e.source = f.node_id \
             WHERE e.generation_id = ?2 AND e.relation = 'calls' AND f.depth < ?3 \
            UNION \
            SELECT e.source, f.depth + 1 FROM graph_edges e \
              JOIN frontier f ON e.target = f.node_id \
             WHERE e.generation_id = ?2 AND e.relation = 'calls' AND f.depth < ?4 \
         ) \
         SELECT DISTINCT n.node_id, n.label, n.source_file, n.start_line \
         FROM frontier f JOIN graph_nodes n \
           ON n.generation_id = ?2 AND n.node_id = f.node_id \
         ORDER BY n.source_file, n.start_line \
         LIMIT ?5",
    )?;
    let nodes = stmt
        .query_map(
            params![node_id, generation_id, callees_depth, callers_depth, limit],
            row_to_hit,
        )?
        .collect::<Result<Vec<_>, _>>()?;

    if nodes.is_empty() {
        return Ok(ExploreResult { nodes: vec![], edges: vec![] });
    }

    let node_ids: Vec<String> = nodes.iter().map(|n| n.node_id.clone()).collect();
    let placeholders = node_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT source, target, relation FROM graph_edges \
         WHERE generation_id = ? AND source IN ({placeholders}) AND target IN ({placeholders})"
    );
    let mut edge_stmt = conn.prepare(&sql)?;
    let mut bind: Vec<&dyn rusqlite::ToSql> = vec![&generation_id];
    for id in &node_ids {
        bind.push(id);
    }
    for id in &node_ids {
        bind.push(id);
    }
    let edges = edge_stmt
        .query_map(bind.as_slice(), |row| {
            Ok(GraphEdgeHit { source: row.get(0)?, target: row.get(1)?, relation: row.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let _ = max_depth; // used only to document the effective bound; both directions are already independently clamped

    Ok(ExploreResult { nodes, edges })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::schema::ensure_schema;

    fn seed(conn: &Connection) {
        ensure_schema(conn).unwrap();
        conn.execute(
            "INSERT INTO index_generations (id, state, created_at, head_sha, dirty, extractor_fingerprint) \
             VALUES ('g1','ACTIVE',0,'sha',0,'fp')",
            [],
        )
        .unwrap();
        // a -> b -> c -> a (cycle), d is isolated.
        for (id, label, file, line) in [
            ("a.rs#1:a", "a()", "a.rs", 1),
            ("b.rs#1:b", "b()", "b.rs", 1),
            ("c.rs#1:c", "c()", "c.rs", 1),
            ("d.rs#1:d", "d()", "d.rs", 1),
        ] {
            conn.execute(
                "INSERT INTO graph_nodes (generation_id, node_id, label, source_file, start_line) VALUES ('g1',?1,?2,?3,?4)",
                params![id, label, file, line],
            )
            .unwrap();
        }
        for (src, tgt) in [("a.rs#1:a", "b.rs#1:b"), ("b.rs#1:b", "c.rs#1:c"), ("c.rs#1:c", "a.rs#1:a")] {
            conn.execute(
                "INSERT INTO graph_edges (generation_id, source, target, relation) VALUES ('g1',?1,?2,'calls')",
                params![src, tgt],
            )
            .unwrap();
        }
    }

    #[test]
    fn find_symbol_matches_case_insensitive_substring() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let hits = find_symbol(&conn, "g1", "B(", None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].node_id, "b.rs#1:b");
    }

    #[test]
    fn callers_and_callees_are_single_hop() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let callers = get_callers(&conn, "g1", "b.rs#1:b", None).unwrap();
        assert_eq!(callers.len(), 1);
        assert_eq!(callers[0].node_id, "a.rs#1:a");

        let callees = get_callees(&conn, "g1", "b.rs#1:b", None).unwrap();
        assert_eq!(callees.len(), 1);
        assert_eq!(callees[0].node_id, "c.rs#1:c");
    }

    #[test]
    fn explore_symbol_terminates_on_a_cycle_and_dedups() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let result = explore_symbol(&conn, "g1", "a.rs#1:a", Some(3), Some(3), None).unwrap();
        // a, b, c reachable; d is isolated and must not appear.
        let ids: std::collections::BTreeSet<_> = result.nodes.iter().map(|n| n.node_id.as_str()).collect();
        assert_eq!(ids, std::collections::BTreeSet::from(["a.rs#1:a", "b.rs#1:b", "c.rs#1:c"]));
        assert_eq!(result.edges.len(), 3, "all three edges of the cycle are induced among the returned nodes");
    }

    #[test]
    fn explore_symbol_depth_zero_returns_only_the_origin() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let result = explore_symbol(&conn, "g1", "a.rs#1:a", Some(0), Some(0), None).unwrap();
        assert_eq!(result.nodes.len(), 1);
        assert_eq!(result.nodes[0].node_id, "a.rs#1:a");
        assert!(result.edges.is_empty());
    }

    #[test]
    fn depth_and_limit_are_clamped_server_side() {
        assert_eq!(clamp_depth(Some(9999), 1), MAX_DEPTH);
        assert_eq!(clamp_limit(Some(-5), 20), 1);
        assert_eq!(clamp_limit(Some(99999), 20), MAX_LIMIT);
    }
}
