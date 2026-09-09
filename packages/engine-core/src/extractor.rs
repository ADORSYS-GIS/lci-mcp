//! Thin wrapper around `lci_codegraph::walk_checkout`, run off the async runtime's worker pool since
//! the walk is synchronous CPU work.
//!
//! Never touches `lci_codegraph::embed`: that module bundles the outbound embedding HTTP call
//! together with header construction, and embedding HTTP belongs in the TypeScript layer, not here.
//! `embed_input` is populated by the store layer as a copy of `content` instead (see `store/chunks.rs`).

use std::path::Path;

use lci_codegraph::{IndexOutput, WalkOptions};

/// Paths that commonly hold host or account credentials — excluded from every walk regardless of
/// the target repository's own `.gitignore`, since a misconfigured `--root` pointed above the
/// intended repository should never expose them to extraction. Composes with, rather than
/// replaces, the repo's own ignore rules and the extraction engine's own junk-directory defaults.
const ALWAYS_EXCLUDED_GLOBS: &[&str] = &[
    ".ssh/",
    ".aws/",
    ".gnupg/",
    ".config/",
    ".kube/",
    ".docker/",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".env",
    ".lci/",
];

pub async fn extract(root: &Path) -> anyhow::Result<IndexOutput> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let options = WalkOptions::builder()
            .build_graph(true)
            .extra_ignore_globs(ALWAYS_EXCLUDED_GLOBS.iter().map(|glob| glob.to_string()).collect::<Vec<_>>())
            .build();
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

    #[tokio::test]
    async fn credential_bearing_paths_are_never_extracted() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".ssh")).unwrap();
        fs::write(dir.path().join(".ssh/id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n").unwrap();
        fs::create_dir_all(dir.path().join(".aws")).unwrap();
        fs::write(dir.path().join(".aws/credentials"), "[default]\naws_access_key_id = fake\n").unwrap();
        fs::write(dir.path().join(".env"), "SECRET=fake\n").unwrap();
        fs::write(dir.path().join("keep.rs"), "fn keep() {}\n").unwrap();

        let out = extract(dir.path()).await.unwrap();

        assert!(!out.chunks.iter().any(|c| c.file_path.contains("id_rsa")));
        assert!(!out.chunks.iter().any(|c| c.file_path.contains("credentials")));
        assert!(!out.chunks.iter().any(|c| c.file_path.contains(".env")));
        assert!(out.chunks.iter().any(|c| c.file_path.contains("keep.rs")));
    }
}
