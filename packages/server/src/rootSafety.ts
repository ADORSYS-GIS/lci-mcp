import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";

/**
 * Resolves symlinks so that two spellings of one directory compare equal. A path that does not exist
 * yet has no real path to resolve, so its lexical form stands in — opening it fails later anyway.
 */
function canonicalize(target: string): string {
  const resolved = path.resolve(target);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** True when `ancestor` is a strict parent of `descendant`, compared by whole path segments. */
function isAncestorOf(ancestor: string, descendant: string): boolean {
  const relative = path.relative(ancestor, descendant);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The home directory as both `$HOME` and the account database report it, so a `$HOME` that points
 * somewhere stale or unresolvable cannot hide the account's real home.
 */
function homeDirectories(): string[] {
  const homes = [homedir()];
  try {
    homes.push(userInfo().homedir);
  } catch {
    // An account without a database entry, such as an arbitrary container UID, has only `$HOME`.
  }
  return homes.map(canonicalize);
}

/**
 * True when `root` resolves to a filesystem root, to the user's home directory, or to any directory
 * containing that home directory. Indexing any of them would walk far more of the host than any
 * single repository, well beyond what the ignore layers in the extraction engine are meant to filter
 * — this is a distinct, structural refusal rather than relying on ever-more exclusions to catch
 * every sensitive path underneath.
 *
 * The rule is positional rather than a list of known directories: everything at or above the home
 * directory is refused, so `/home` and `/Users` are covered on the way to the filesystem root without
 * naming either. Paths *below* the home directory stay allowed — that is where repositories live.
 */
export function isUnsafeIndexRoot(root: string): boolean {
  const resolved = canonicalize(root);
  if (resolved === path.parse(resolved).root) return true;

  return homeDirectories().some((home) => resolved === home || isAncestorOf(resolved, home));
}
