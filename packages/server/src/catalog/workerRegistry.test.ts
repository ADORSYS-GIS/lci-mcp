import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CodeIndex } from "../engine.js";
import { RepositoryCatalogStore } from "./store.js";
import { RepositoryWorkerRegistry, type RepositoryWorkerResources } from "./workerRegistry.js";

const repository = {
  repositoryId: "repo-a",
  displayName: "Repository A",
  remoteUrl: "https://git.example.test/team/repo-a",
  checkoutPath: "/var/lib/lci/checkouts/repo-a",
  enabled: true,
  queryable: true,
  lifecycle: "ready" as const,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
};

async function makeCatalog() {
  const directory = await mkdtemp(path.join(tmpdir(), "lci-worker-test-"));
  const catalog = new RepositoryCatalogStore(path.join(directory, "catalog.json"));
  await catalog.add(repository);
  return { catalog, storageRoot: path.join(directory, "indexes") };
}

function fakeResources(close?: () => void): RepositoryWorkerResources {
  return { codeIndex: {} as CodeIndex, close };
}

describe("RepositoryWorkerRegistry", () => {
  it("lazily opens one worker and reuses it", async () => {
    const { catalog, storageRoot } = await makeCatalog();
    let opens = 0;
    const registry = new RepositoryWorkerRegistry({
      catalog,
      storageRoot,
      factory: async () => {
        opens++;
        return fakeResources();
      },
    });

    const first = await registry.resolve("repo-a");
    const second = await registry.resolve("repo-a");
    expect(first).toBe(second);
    expect(opens).toBe(1);
    expect(first.databasePath).toBe(path.join(storageRoot, "repo-a", "index.sqlite"));
    expect(first.repositoryRoot).toBe(repository.checkoutPath);
  });

  it("deduplicates concurrent opens and isolates database paths", async () => {
    const { catalog, storageRoot } = await makeCatalog();
    await catalog.add({
      ...repository,
      repositoryId: "repo-b",
      displayName: "Repository B",
      checkoutPath: "/var/lib/lci/checkouts/repo-b",
    });
    let opens = 0;
    const registry = new RepositoryWorkerRegistry({
      catalog,
      storageRoot,
      factory: async (_repository, _databasePath) => {
        opens++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return fakeResources();
      },
    });

    const [a1, a2, b] = await Promise.all([
      registry.resolve("repo-a"),
      registry.resolve("repo-a"),
      registry.resolve("repo-b"),
    ]);
    expect(a1).toBe(a2);
    expect(a1.databasePath).not.toBe(b.databasePath);
    expect(opens).toBe(2);
  });

  it("rejects unknown, disabled, and non-queryable repositories before opening", async () => {
    const { catalog, storageRoot } = await makeCatalog();
    await catalog.add({ ...repository, repositoryId: "disabled", enabled: false });
    await catalog.add({ ...repository, repositoryId: "not-ready", queryable: false, lifecycle: "registered" });
    let opens = 0;
    const registry = new RepositoryWorkerRegistry({
      catalog,
      storageRoot,
      factory: async () => {
        opens++;
        return fakeResources();
      },
    });

    await expect(registry.resolve("missing")).rejects.toThrow("repository not found");
    await expect(registry.resolve("disabled")).rejects.toThrow("repository is unavailable");
    await expect(registry.resolve("not-ready")).rejects.toThrow("repository is not queryable");
    expect(opens).toBe(0);
  });

  it("checks authorization before opening a worker", async () => {
    const { catalog, storageRoot } = await makeCatalog();
    let opens = 0;
    const registry = new RepositoryWorkerRegistry({
      catalog,
      storageRoot,
      authorize: async () => false,
      factory: async () => {
        opens++;
        return fakeResources();
      },
    });

    await expect(registry.resolve("repo-a")).rejects.toThrow("repository access denied");
    expect(opens).toBe(0);
  });

  it("enforces the worker capacity and closes cached workers", async () => {
    const { catalog, storageRoot } = await makeCatalog();
    await catalog.add({
      ...repository,
      repositoryId: "repo-b",
      displayName: "Repository B",
      checkoutPath: "/var/lib/lci/checkouts/repo-b",
    });
    const closed: string[] = [];
    const registry = new RepositoryWorkerRegistry({
      catalog,
      storageRoot,
      maxWorkers: 1,
      factory: async (record) => fakeResources(() => closed.push(record.repositoryId)),
    });

    await registry.resolve("repo-a");
    await expect(registry.resolve("repo-b")).rejects.toThrow("worker capacity reached");
    await registry.closeAll();
    expect(closed).toEqual(["repo-a"]);
    expect(registry.size).toBe(0);
  });
});
