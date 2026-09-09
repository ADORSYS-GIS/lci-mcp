import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { expandTemplate, platformDataDir, type TemplateContext } from "./template.js";

const ctx: TemplateContext = {
  repoRoot: "/work/project",
  repoName: "project",
  repoKey: "abc123",
  headSha: "deadbeef",
  shortHeadSha: "deadbeef".slice(0, 8),
  homeDir: "/home/dev",
  tmpDir: "/tmp",
  dataDir: "/home/dev/.local/share",
};

describe("expandTemplate", () => {
  it("substitutes a known variable", () => {
    expect(expandTemplate("{{repoRoot}}/.lci/index.sqlite", ctx)).toBe("/work/project/.lci/index.sqlite");
  });

  it("substitutes multiple variables in one string", () => {
    expect(expandTemplate("{{tmpDir}}/lci-mcp/{{repoKey}}/index.sqlite", ctx)).toBe("/tmp/lci-mcp/abc123/index.sqlite");
  });

  it("substitutes dataDir, the default database location's own variable", () => {
    expect(expandTemplate("{{dataDir}}/lci-mcp/{{repoKey}}/index.sqlite", ctx)).toBe(
      "/home/dev/.local/share/lci-mcp/abc123/index.sqlite",
    );
  });

  it("throws on an unknown variable rather than leaving it unresolved", () => {
    expect(() => expandTemplate("{{notAVariable}}", ctx)).toThrow(/unknown template variable/);
  });

  it("a literal string with no template syntax passes through unchanged", () => {
    expect(expandTemplate("/absolute/path/index.sqlite", ctx)).toBe("/absolute/path/index.sqlite");
  });
});

describe("platformDataDir", () => {
  const originalPlatform = process.platform;
  const originalXdg = process.env.XDG_DATA_HOME;
  const originalLocalAppData = process.env.LOCALAPPDATA;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
  });

  it("honors XDG_DATA_HOME on Linux when set", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.XDG_DATA_HOME = "/custom/xdg";
    expect(platformDataDir()).toBe("/custom/xdg");
  });

  it("falls back to ~/.local/share on Linux without XDG_DATA_HOME", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    delete process.env.XDG_DATA_HOME;
    expect(platformDataDir()).toBe(path.join(homedir(), ".local", "share"));
  });

  it("uses ~/Library/Application Support on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(platformDataDir()).toBe(path.join(homedir(), "Library", "Application Support"));
  });

  it("honors LOCALAPPDATA on Windows when set", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.LOCALAPPDATA = "C:\\custom\\local";
    expect(platformDataDir()).toBe("C:\\custom\\local");
  });

  it("falls back to ~/AppData/Local on Windows without LOCALAPPDATA", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.LOCALAPPDATA;
    expect(platformDataDir()).toBe(path.join(homedir(), "AppData", "Local"));
  });
});
