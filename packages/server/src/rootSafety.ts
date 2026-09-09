import { homedir } from "node:os";
import path from "node:path";

/**
 * True when `root` resolves to the user's home directory or a filesystem root. Indexing either
 * would walk far more of the host than any single repository, well beyond what the ignore layers
 * in the extraction engine are meant to filter — this is a distinct, structural refusal rather than
 * relying on ever-more exclusions to catch every sensitive path underneath.
 */
export function isUnsafeIndexRoot(root: string): boolean {
  const resolved = path.resolve(root);
  if (resolved === path.resolve(homedir())) return true;
  return resolved === path.parse(resolved).root;
}
