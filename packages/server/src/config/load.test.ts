import { describe, expect, it } from "vitest";

import { deepMergeReplacingArrays, rejectInlineCredential, resolveConfig } from "./load.js";

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
    expect(config.storage.database).toBe("{{dataDir}}/lci-mcp/{{repoKey}}/index.sqlite");
    expect(config.storage.catalog).toBe("{{dataDir}}/lci-mcp/catalog.json");
    expect(config.storage.indexRoot).toBe("{{dataDir}}/lci-mcp/repos");
    expect(config.index.autoIndex).toBe(false);
    expect(config.index.maxConcurrentRepositories).toBe(2);
    expect(config.repositories).toEqual([]);
    expect(config.logging.level).toBe("info");
  });

  it("accepts a repository manifest without exposing checkout paths in its safe summary", () => {
    const config = resolveConfig([
      {
        name: "file",
        value: {
          repositories: [
            {
              repositoryId: "repo-a",
              displayName: "Repository A",
              remoteUrl: "https://git.example.test/team/repo-a",
              checkoutPath: "/var/lib/lci/checkouts/repo-a",
            },
          ],
        },
      },
    ]);
    expect(config.repositories[0]?.repositoryId).toBe("repo-a");
  });

  it("rejects duplicate IDs and relative checkout paths", () => {
    const entry = {
      repositoryId: "repo-a",
      displayName: "Repository A",
      remoteUrl: "https://git.example.test/team/repo-a",
      checkoutPath: "/var/lib/lci/checkouts/repo-a",
    };
    expect(() => resolveConfig([{ name: "file", value: { repositories: [entry, entry] } }])).toThrow(
      "duplicate repository IDs",
    );
    expect(() =>
      resolveConfig([{ name: "file", value: { repositories: [{ ...entry, checkoutPath: "repo-a" }] } }]),
    ).toThrow("checkoutPath must be absolute");
    expect(() => resolveConfig([{ name: "file", value: { storage: { catalog: "catalog.json" } } }])).toThrow(
      "catalog must be absolute or use a template",
    );
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

describe("rejectInlineCredential", () => {
  it("throws when an embedding API key is present", () => {
    expect(() => rejectInlineCredential("--config-json", { embedding: { auth: { apiKey: "sk-secret" } } })).toThrow(
      /must not be set via --config-json/,
    );
  });

  it("passes through a value with no embedding auth at all", () => {
    expect(() => rejectInlineCredential("--config-json", { embedding: { model: "m" } })).not.toThrow();
  });

  it("passes through an auth helper (no api key) unmodified", () => {
    expect(() =>
      rejectInlineCredential("--config-json", { embedding: { auth: { helper: { command: "get-token" } } } }),
    ).not.toThrow();
  });

  it("ignores a non-object value", () => {
    expect(() => rejectInlineCredential("--config-json", undefined)).not.toThrow();
  });
});
