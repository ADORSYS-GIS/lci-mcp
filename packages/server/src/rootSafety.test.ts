import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isUnsafeIndexRoot } from "./rootSafety.js";

describe("isUnsafeIndexRoot", () => {
  it("flags the user's home directory", () => {
    expect(isUnsafeIndexRoot(homedir())).toBe(true);
  });

  it("flags a filesystem root", () => {
    expect(isUnsafeIndexRoot(path.parse(process.cwd()).root)).toBe(true);
  });

  it("does not flag an ordinary repository path", () => {
    expect(isUnsafeIndexRoot(path.join(homedir(), "projects", "example"))).toBe(false);
  });
});
