import { describe, expect, it } from "vitest";

import { sanitizeToolError } from "./toolResult.js";

describe("sanitizeToolError", () => {
  it("collapses path-bearing errors to a generic message", () => {
    expect(sanitizeToolError(new Error('failed to read catalog "/home/op/.config/lci/catalog.json": EACCES'))).toBe(
      "request failed",
    );
    expect(sanitizeToolError(new Error("sqlite: unable to open database file /var/lib/lci/repos/a/index.sqlite"))).toBe(
      "request failed",
    );
    expect(sanitizeToolError("not an error object")).toBe("request failed");
  });

  it("preserves repository/policy messages that name no paths", () => {
    for (const message of [
      "repository not found: repo-a",
      "repository is not queryable: repo-a",
      "repository access denied: repo-a",
      "repository worker capacity reached",
      "repository checkout path is unsafe to index: repo-a",
      "repository_id is required for this MCP server",
    ]) {
      expect(sanitizeToolError(new Error(message))).toBe(message);
    }
  });
});
