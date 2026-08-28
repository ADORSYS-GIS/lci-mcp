//! Thin wrapper around `lci_codegraph::walk_checkout`, run off the async runtime's worker pool since
//! the walk is synchronous CPU work.
//!
//! Never touches `lci_codegraph::embed`: that module bundles the outbound embedding HTTP call
//! together with header construction, and embedding HTTP belongs in the TypeScript layer, not here.
//! `embed_input` is populated by the store layer as a copy of `content` instead (see `store/chunks.rs`).

use std::path::Path;

use lci_codegraph::{IndexOutput, WalkOptions};

pub async fn extract(root: &Path) -> anyhow::Result<IndexOutput> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let options = WalkOptions::builder().build_graph(true).build();
        lci_codegraph::walk_checkout(&root, &options)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn extracts_chunks_and_graph_from_a_real_checkout() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.rs"), "fn caller() { target(); }\n").unwrap();
        fs::write(dir.path().join("b.rs"), "fn target() {}\n").unwrap();

        let out = extract(dir.path()).await.unwrap();

        assert!(!out.chunks.is_empty());
        assert!(!out.graph.nodes.is_empty());
        assert!(
            out.graph.edges.iter().any(|e| e.relation == "calls"),
            "cross-file calls edge expected, got {:?}",
            out.graph.edges
        );
    }
}
