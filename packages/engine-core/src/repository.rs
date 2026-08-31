//! Repository identity: canonical root, HEAD, dirty state, and a stable `repoKey`. Uses `git2`
//! rather than shelling out to `git`.

use std::path::{Path, PathBuf};

use git2::Repository;

pub struct RepositoryInfo {
    pub canonical_root: PathBuf,
    pub head_sha: String,
    pub dirty: bool,
    pub remote_identity: Option<String>,
    pub repo_key: String,
}

/// Normalizes a remote URL to `{host}/{owner}/{repo}` lowercase, `.git` suffix stripped, so
/// `git@github.com:acme/widgets.git` and `https://github.com/acme/widgets` collapse to the same
/// identity string.
fn normalize_remote(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let without_git_suffix = trimmed.strip_suffix(".git").unwrap_or(trimmed);

    let host_and_path = if let Some(rest) = without_git_suffix.strip_prefix("git@") {
        // git@host:owner/repo
        rest.replacen(':', "/", 1)
    } else if let Some(rest) = without_git_suffix.strip_prefix("ssh://git@") {
        rest.to_string()
    } else if let Some(rest) = without_git_suffix.strip_prefix("https://") {
        rest.to_string()
    } else {
        let rest = without_git_suffix.strip_prefix("http://")?;
        rest.to_string()
    };

    let normalized = host_and_path.trim_matches('/').to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn repo_key_for(remote_identity: Option<&str>, canonical_root: &Path) -> String {
    let identity_input = match remote_identity {
        Some(remote) => remote.to_string(),
        None => format!("no-remote:{}", canonical_root.display()),
    };
    let hash = blake3::hash(identity_input.as_bytes());
    hash.to_hex()[..16].to_string()
}

pub fn inspect(root: &Path) -> anyhow::Result<RepositoryInfo> {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());

    let repo = Repository::discover(&canonical_root).ok();

    let (head_sha, dirty, remote_identity, git_root) = match &repo {
        Some(repo) => {
            let head_sha = repo
                .head()
                .ok()
                .and_then(|h| h.target())
                .map(|oid| oid.to_string())
                .unwrap_or_else(|| "0".repeat(40));

            let dirty = {
                let mut opts = git2::StatusOptions::new();
                opts.include_untracked(true).recurse_untracked_dirs(false);
                repo.statuses(Some(&mut opts))
                    .map(|statuses| !statuses.is_empty())
                    .unwrap_or(false)
            };

            let remote_identity = repo
                .find_remote("origin")
                .ok()
                .and_then(|r| r.url().ok().map(str::to_string))
                .and_then(|url| normalize_remote(&url));

            let git_root = repo
                .workdir()
                .map(Path::to_path_buf)
                .and_then(|p| p.canonicalize().ok());

            (head_sha, dirty, remote_identity, git_root)
        }
        None => ("0".repeat(40), false, None, None),
    };

    let repo_key_root = git_root.as_deref().unwrap_or(&canonical_root);
    let repo_key = repo_key_for(remote_identity.as_deref(), repo_key_root);

    Ok(RepositoryInfo {
        canonical_root: git_root.unwrap_or(canonical_root),
        head_sha,
        dirty,
        remote_identity,
        repo_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_and_https_forms_of_the_same_remote_normalize_identically() {
        let ssh = normalize_remote("git@github.com:acme/widgets.git").unwrap();
        let https = normalize_remote("https://github.com/acme/widgets").unwrap();
        assert_eq!(ssh, https);
        assert_eq!(ssh, "github.com/acme/widgets");
    }

    #[test]
    fn no_remote_falls_back_to_canonical_root_identity() {
        let a = repo_key_for(None, Path::new("/work/project-a"));
        let b = repo_key_for(None, Path::new("/work/project-b"));
        assert_ne!(a, b, "two different no-remote roots must not collide");
    }

    #[test]
    fn two_clones_of_the_same_remote_share_a_repo_key() {
        let identity = normalize_remote("https://github.com/acme/widgets").unwrap();
        let a = repo_key_for(Some(&identity), Path::new("/home/a/widgets"));
        let b = repo_key_for(Some(&identity), Path::new("/home/b/code/widgets-clone"));
        assert_eq!(a, b, "repoKey must be derived from the remote, not the local path, when a remote exists");
    }

    #[test]
    fn repo_key_is_16_hex_chars() {
        let key = repo_key_for(Some("github.com/a/b"), Path::new("/x"));
        assert_eq!(key.len(), 16);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn inspect_a_real_temp_git_repo() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();

        let info = inspect(dir.path()).unwrap();
        assert_eq!(info.head_sha.len(), 40);
        assert!(!info.dirty, "clean repo right after commit must not be dirty");
        assert!(info.remote_identity.is_none());

        std::fs::write(dir.path().join("b.txt"), "uncommitted").unwrap();
        let info2 = inspect(dir.path()).unwrap();
        assert!(info2.dirty, "an untracked file must be reported as dirty");
        assert_eq!(info.repo_key, info2.repo_key, "repoKey is stable across dirty-state changes");
    }
}
