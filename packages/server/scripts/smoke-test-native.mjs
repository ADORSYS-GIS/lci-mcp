// Confirms the native addon actually resolves and exposes its exports on the platform running this
// script, so a broken build for *that* platform fails loudly here rather than surfacing as someone
// else's install-time error. Runs on the release job's own (Linux) runner, so it only ever exercises
// the host binding — a broken cross-compiled artifact for another platform isn't caught by this.
import { CodeIndex, repositoryIdentity } from "@vymalo/lightbridge-code-intelligence-native";

if (typeof CodeIndex !== "function" || typeof repositoryIdentity !== "function") {
  throw new Error("native binding loaded but is missing expected exports");
}

console.log("native binding loaded and exposes CodeIndex + repositoryIdentity");
