import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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

  describe("when $HOME does not resolve", () => {
    const missingHome = `${scratch}-missing-home`;
    afterEach(() => vi.unstubAllEnvs());

    it("still flags the account's home directory", () => {
      vi.stubEnv("HOME", missingHome);
      expect(isUnsafeIndexRoot(userInfo().homedir)).toBe(true);
    });

    it("does not flag a repository outside the home directory", () => {
      vi.stubEnv("HOME", missingHome);
      expect(isUnsafeIndexRoot(scratch)).toBe(false);
    });
  });

  describe("with an unusual $HOME", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("does not treat an empty $HOME as the working directory", () => {
      vi.stubEnv("HOME", "");
      expect(isUnsafeIndexRoot(path.dirname(process.cwd()))).toBe(false);
    });

    it("flags the parent of a home directory whose name starts with dots", () => {
      const parent = path.join(scratch, "homes");
      const home = path.join(parent, "..profile");
      mkdirSync(home, { recursive: true });
      vi.stubEnv("HOME", home);
      expect(isUnsafeIndexRoot(parent)).toBe(true);
    });
  });
});
