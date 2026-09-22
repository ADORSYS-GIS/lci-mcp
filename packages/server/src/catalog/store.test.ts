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
    await store.transition("repo-a", "provisioning");
    expect((await store.get("repo-a"))?.lifecycle).toBe("provisioning");
    await expect(store.transition("repo-a", "ready")).rejects.toThrow("invalid repository lifecycle transition");
  });

  it("writes restrictive file permissions where supported", async () => {
    const { filePath, store } = await makeStore();
    await store.add(repository);
    const contents = await readFile(filePath, "utf8");
    expect(JSON.parse(contents).schemaVersion).toBe(1);
  });
});
