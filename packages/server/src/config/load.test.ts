import { describe, expect, it } from "vitest";

import { deepMergeReplacingArrays, resolveConfig } from "./load.js";

describe("deepMergeReplacingArrays", () => {
  it("deep-merges nested objects", () => {
    const merged = deepMergeReplacingArrays({ a: { x: 1, y: 2 } }, { a: { y: 3 } });
    expect(merged).toEqual({ a: { x: 1, y: 3 } });
  });

  it("replaces arrays wholesale rather than concatenating", () => {
    const merged = deepMergeReplacingArrays({ globs: ["a", "b"] }, { globs: ["c"] });
    expect(merged).toEqual({ globs: ["c"] });
  });

  it("a later undefined value does not erase an earlier one", () => {
    const merged = deepMergeReplacingArrays({ a: 1 }, undefined);
    expect(merged).toEqual({ a: 1 });
  });
});

describe("resolveConfig precedence", () => {
  it("later layers win over earlier ones", () => {
    const config = resolveConfig([
      { name: "file", value: { logging: { level: "debug" } } },
      { name: "env", value: { logging: { level: "warn" } } },
      { name: "cli", value: { logging: { level: "error" } } },
    ]);
    expect(config.logging.level).toBe("error");
  });

  it("an earlier layer's value survives when a later layer omits that key", () => {
    const config = resolveConfig([
      { name: "file", value: { embedding: { model: "custom-model" } } },
      { name: "cli", value: { logging: { level: "debug" } } },
    ]);
    expect(config.embedding.model).toBe("custom-model");
    expect(config.logging.level).toBe("debug");
  });

  it("every field gets its schema default when no layer sets it", () => {
    const config = resolveConfig([]);
    expect(config.embedding.batchSize).toBe(64);
    expect(config.storage.database).toBe("{{repoRoot}}/.lci/index.sqlite");
    expect(config.index.autoIndex).toBe(false);
    expect(config.logging.level).toBe("info");
  });

  it("rejects an unknown top-level key (schema is .strict())", () => {
    expect(() => resolveConfig([{ name: "file", value: { notAField: true } }])).toThrow();
  });

  it("LCI_CONFIG_CONTENT and an equivalent --config file produce byte-identical resolved config", () => {
    const raw = { embedding: { baseUrl: "https://example.com/v1", model: "m" } };
    const fromEnvContent = resolveConfig([
      { name: "defaults", value: { embedding: {}, storage: {}, index: {}, logging: {} } },
      { name: "env-content", value: raw },
    ]);
    const fromFile = resolveConfig([
      { name: "defaults", value: { embedding: {}, storage: {}, index: {}, logging: {} } },
      { name: "file", value: raw },
    ]);
    expect(fromEnvContent).toEqual(fromFile);
  });
});
