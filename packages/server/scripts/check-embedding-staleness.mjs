import os from "node:os";
import path from "node:path";

import { CodeIndex } from "@vymalo/lightbridge-code-intelligence-native";

// Usage: node check-embedding-staleness.mjs <repository-path> [database-path] [embedding-fingerprint]
// Any argument may instead be supplied via LCI_CHECK_REPOSITORY / LCI_CHECK_DATABASE /
// LCI_CHECK_FINGERPRINT so the script is portable across machines and checkouts.
const repository = process.argv[2] ?? process.env.LCI_CHECK_REPOSITORY;
if (!repository) {
  console.error("usage: node check-embedding-staleness.mjs <repository-path> [database-path] [embedding-fingerprint]");
  console.error("   or set LCI_CHECK_REPOSITORY (and optionally LCI_CHECK_DATABASE, LCI_CHECK_FINGERPRINT)");
  process.exit(2);
}

const fingerprint = process.argv[4] ?? process.env.LCI_CHECK_FINGERPRINT ?? "qwen3-embedding-8b:1536";
const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
const database =
  process.argv[3] ??
  process.env.LCI_CHECK_DATABASE ??
  path.join(dataHome, "lci-mcp", "company-repositories", path.basename(repository), "index.sqlite");

const index = await CodeIndex.open({ repository, database });

const withEmbeddings = await index.status(fingerprint);
console.log(
  `expected=${fingerprint} -> state:`,
  withEmbeddings.state,
  "usable:",
  withEmbeddings.usable,
  "staleReasons:",
  withEmbeddings.staleReasons,
);

const structuralOnly = await index.status();
console.log("expected=none -> staleReasons:", structuralOnly.staleReasons);

const embeddingStale = withEmbeddings.staleReasons.includes("embedding_fingerprint_changed");
const noneNotStale = !structuralOnly.staleReasons.includes("embedding_fingerprint_changed");
console.log(embeddingStale && noneNotStale ? "PASS: embedding staleness detected correctly" : "FAIL");
