import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { type GitCheckoutAdapter, RepositoryProvisioner } from "./provisioning.js";
import { RepositoryCatalogStore } from "./store.js";

class FakeGit implements GitCheckoutAdapter {
  calls: Array<{ remoteUrl: string; checkoutPath: string }> = [];

  async ensureCheckout(remoteUrl: string, checkoutPath: string): Promise<void> {
    this.calls.push({ remoteUrl, checkoutPath });
  }
}

async function makeProvisioner() {
  const directory = await mkdtemp(path.join(tmpdir(), "lci-provisioning-test-"));
  const catalog = new RepositoryCatalogStore(path.join(directory, "catalog.json"));
  const git = new FakeGit();
  const provisioner = new RepositoryProvisioner(
    catalog,
    {
      checkoutRoot: path.join(directory, "checkouts"),
      allowedHosts: ["git.example.test"],
    },
    git,
  );
  return { catalog, git, provisioner, directory };
}

describe("RepositoryProvisioner", () => {
  it("registers a repository under the approved checkout root", async () => {
    const { provisioner } = await makeProvisioner();
    const record = await provisioner.register({
      repositoryId: "repo-a",
      displayName: "Repository A",
      remoteUrl: "https://git.example.test/team/repo-a",
    });
    expect(record.checkoutPath).toMatch(/checkouts[\\/]repo-a$/);
    expect(record.queryable).toBe(false);
  });

  it("rejects disallowed hosts and embedded credentials", async () => {
    const { provisioner } = await makeProvisioner();
    await expect(
      provisioner.register({ repositoryId: "repo-a", displayName: "A", remoteUrl: "https://evil.test/a" }),
    ).rejects.toThrow("Git host is not allowed");
    await expect(
      provisioner.register({
        repositoryId: "repo-a",
        displayName: "A",
        remoteUrl: "https://user:secret@git.example.test/a",
      }),
    ).rejects.toThrow("without embedded credentials");
  });

  it("provisions through the adapter and keeps the record non-queryable until indexing", async () => {
    const { provisioner, git } = await makeProvisioner();
    await provisioner.register({ repositoryId: "repo-a", displayName: "A", remoteUrl: "https://git.example.test/a" });
    const record = await provisioner.provision("repo-a");
    expect(git.calls).toHaveLength(1);
    expect(record.lifecycle).toBe("registered");
    expect(record.queryable).toBe(false);
  });

  it("marks provisioning failures and supports non-destructive disable/remove", async () => {
    const { provisioner, catalog } = await makeProvisioner();
    await provisioner.register({ repositoryId: "repo-a", displayName: "A", remoteUrl: "https://git.example.test/a" });
    await provisioner.disable("repo-a");
    expect((await catalog.get("repo-a"))?.lifecycle).toBe("disabled");
    await provisioner.remove("repo-a");
    expect((await catalog.get("repo-a"))?.lifecycle).toBe("removed");
  });
});
