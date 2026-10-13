import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isUnsafeIndexRoot } from "./rootSafety.js";

const scratch = mkdtempSync(path.join(realpathSync.native(tmpdir()), "lci-root-safety-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("isUnsafeIndexRoot", () => {
  it("flags the user's home directory", () => {
    expect(isUnsafeIndexRoot(homedir())).toBe(true);
  });

  it("flags a filesystem root", () => {
    expect(isUnsafeIndexRoot(path.parse(process.cwd()).root)).toBe(true);
  });

  it("flags the directory holding the home directory", () => {
    expect(isUnsafeIndexRoot(path.dirname(homedir()))).toBe(true);
  });

  it("flags every directory between the filesystem root and the home directory", () => {
    let current = path.dirname(homedir());
    const filesystemRoot = path.parse(current).root;
    while (current !== filesystemRoot) {
      expect(isUnsafeIndexRoot(current)).toBe(true);
      current = path.dirname(current);
    }
  });

  it("flags a traversal that lands above the home directory", () => {
    expect(isUnsafeIndexRoot(path.join(homedir(), ".."))).toBe(true);
  });

  it("flags a path that only reaches the home directory through a symlink", () => {
    const link = path.join(scratch, "home-link");
    symlinkSync(homedir(), link, "dir");
    expect(isUnsafeIndexRoot(link)).toBe(true);
  });

  it("does not flag an ordinary repository path", () => {
    expect(isUnsafeIndexRoot(path.join(homedir(), "projects", "example"))).toBe(false);
  });

  it("does not flag a repository outside the home directory", () => {
    expect(isUnsafeIndexRoot(scratch)).toBe(false);
  });

  it("does not flag the home directory reached back through a child", () => {
    expect(isUnsafeIndexRoot(path.join(homedir(), "projects", "..", "projects"))).toBe(false);
  });
});
