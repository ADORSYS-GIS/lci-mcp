import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readLineRange, registerReadSourceTool, resolveWithinRoot } from "./readSource.js";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lci-read-root-"));
  outside = await mkdtemp(path.join(tmpdir(), "lci-read-out-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "file.ts"), ["line1", "line2", "line3", "line4", "line5"].join("\n"), "utf8");
  await writeFile(path.join(outside, "secret.env"), "TOKEN=1", "utf8");
  await symlink(path.join(outside, "secret.env"), path.join(root, "escape.env")).catch(() => undefined);
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("lci_read_source", () => {
  it("registers as a tool", () => {
    expect(registerReadSourceTool).toBeTypeOf("function");
  });

  it("resolves a path inside the repository", async () => {
    const resolved = await resolveWithinRoot(root, "src/file.ts");
    expect(resolved).toBe(path.join(await import("node:fs/promises").then((m) => m.realpath(root)), "src", "file.ts"));
  });

  it("rejects absolute paths, traversal, and symlink escapes", async () => {
    expect(await resolveWithinRoot(root, path.join(outside, "secret.env"))).toBeUndefined();
    expect(await resolveWithinRoot(root, "../escape")).toBeUndefined();
    expect(await resolveWithinRoot(root, "src/../../out/secret.env")).toBeUndefined();
    expect(await resolveWithinRoot(root, "escape.env")).toBeUndefined();
  });

  it("reads an inclusive, clamped line range", async () => {
    const resolved = (await resolveWithinRoot(root, "src/file.ts"))!;
    expect(await readLineRange(resolved, 2, 3)).toEqual({ startLine: 2, endLine: 3, content: "line2\nline3" });
    expect(await readLineRange(resolved, 4, 999)).toEqual({ startLine: 4, endLine: 5, content: "line4\nline5" });
  });
});
