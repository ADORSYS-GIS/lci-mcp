import { describe, expect, it } from "vitest";

import { expandTemplate, type TemplateContext } from "./template.js";

const ctx: TemplateContext = {
  repoRoot: "/work/project",
  repoName: "project",
  repoKey: "abc123",
  headSha: "deadbeef",
  shortHeadSha: "deadbeef".slice(0, 8),
  homeDir: "/home/dev",
  tmpDir: "/tmp",
};

describe("expandTemplate", () => {
  it("substitutes a known variable", () => {
    expect(expandTemplate("{{repoRoot}}/.lci/index.sqlite", ctx)).toBe("/work/project/.lci/index.sqlite");
  });

  it("substitutes multiple variables in one string", () => {
    expect(expandTemplate("{{tmpDir}}/lci-mcp/{{repoKey}}/index.sqlite", ctx)).toBe("/tmp/lci-mcp/abc123/index.sqlite");
  });

  it("throws on an unknown variable rather than leaving it unresolved", () => {
    expect(() => expandTemplate("{{notAVariable}}", ctx)).toThrow(/unknown template variable/);
  });

  it("a literal string with no template syntax passes through unchanged", () => {
    expect(expandTemplate("/absolute/path/index.sqlite", ctx)).toBe("/absolute/path/index.sqlite");
  });
});
