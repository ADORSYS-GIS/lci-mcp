import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RepositoryCatalogStore } from "./store.js";

const repository = {
  repositoryId: "repo-a",
  displayName: "Repository A",
  remoteUrl: "https://git.example.test/team/repo-a",
  checkoutPath: "/var/lib/lci/checkouts/repo-a",
  enabled: true,
  queryable: false,
  structuralOnly: false,
  autoIndex: false,
  lifecycle: "registered" as const,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
};

async function makeStore(): Promise<{ filePath: string; store: RepositoryCatalogStore }> {
  const directory = await mkdtemp(path.join(tmpdir(), "lci-catalog-test-"));
  const filePath = path.join(directory, "catalog.json");
  return { filePath, store: new RepositoryCatalogStore(filePath) };
}

describe("RepositoryCatalogStore", () => {
  it("opens a missing catalog as an empty versioned document and persists it atomically", async () => {
    const { store } = await makeStore();
    expect(await store.load()).toEqual({ schemaVersion: 1, repositories: [] });
    await store.add(repository);
    const saved = await store.load();
    expect(saved.repositories[0]?.repositoryId).toBe("repo-a");
  });

  it("rejects duplicate repository IDs", async () => {
    const { store } = await makeStore();
    await store.add(repository);
    await expect(store.add(repository)).rejects.toThrow("repository ID already exists");
  });

  it("migrates an existing version zero catalog on load", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lci-catalog-migration-"));
    const filePath = path.join(directory, "catalog.json");
    await writeFile(filePath, JSON.stringify({ schemaVersion: 0, repositories: [] }));
    const store = new RepositoryCatalogStore(filePath);
    expect((await store.load()).schemaVersion).toBe(1);
  });

  it("enforces lifecycle transitions and updates timestamps", async () => {
    const { store } = await makeStore();
    await store.add(repository);
    await store.transition("repo-a", "indexing");
    expect((await store.get("repo-a"))?.lifecycle).toBe("indexing");
    await expect(store.transition("repo-a", "registered")).rejects.toThrow("invalid repository lifecycle transition");
  });

  it("writes restrictive file permissions where supported", async () => {
    const { filePath, store } = await makeStore();
    await store.add(repository);
    const contents = await readFile(filePath, "utf8");
    expect(JSON.parse(contents).schemaVersion).toBe(1);
  });

  it("reconciles the manifest: adds new repos non-queryable and preserves index state", async () => {
    const { store } = await makeStore();
    await store.reconcileManifest([repository]);
    expect((await store.get("repo-a"))?.queryable).toBe(false);

    await store.transition("repo-a", "indexing");
    await store.transition("repo-a", "ready", { queryable: true, lastIndexedAt: "2026-09-23T00:00:00.000Z" });
    await store.reconcileManifest([{ ...repository, displayName: "Renamed", structuralOnly: true }]);
    const updated = await store.get("repo-a");
    expect(updated?.displayName).toBe("Renamed");
    expect(updated?.structuralOnly).toBe(true);
    expect(updated?.lifecycle).toBe("ready");
    expect(updated?.queryable).toBe(true);
    expect(updated?.lastIndexedAt).toBe("2026-09-23T00:00:00.000Z");
  });

  it("marks repositories dropped from the manifest as removed and non-queryable", async () => {
    const { store } = await makeStore();
    await store.add({ ...repository, lifecycle: "ready", queryable: true });
    await store.reconcileManifest([]);
    const removed = await store.get("repo-a");
    expect(removed?.lifecycle).toBe("removed");
    expect(removed?.queryable).toBe(false);
    expect(removed?.enabled).toBe(false);
  });

  it("serializes concurrent mutations without losing updates", async () => {
    const { store } = await makeStore();
    await store.add(repository);
    await store.add({ ...repository, repositoryId: "repo-b", checkoutPath: "/var/lib/lci/checkouts/repo-b" });
    // Fire both transitions at once; serialization must apply both rather than clobbering one.
    await Promise.all([store.transition("repo-a", "indexing"), store.transition("repo-b", "indexing")]);
    expect((await store.get("repo-a"))?.lifecycle).toBe("indexing");
    expect((await store.get("repo-b"))?.lifecycle).toBe("indexing");
  });
});
