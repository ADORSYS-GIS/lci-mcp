// Confirms the native addon actually resolves and exposes its exports, so a target missing from a
// release fails the build loudly here rather than surfacing as someone else's install-time error.
import { CodeIndex, repositoryIdentity } from "@vymalo/lightbridge-code-intelligence-native";

if (typeof CodeIndex !== "function" || typeof repositoryIdentity !== "function") {
  throw new Error("native binding loaded but is missing expected exports");
}

console.log("native binding loaded and exposes CodeIndex + repositoryIdentity");
