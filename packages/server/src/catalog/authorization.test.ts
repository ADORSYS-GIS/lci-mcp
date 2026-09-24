import { describe, expect, it } from "vitest";

import { createRepositoryAuthorizer } from "./authorization.js";
import type { RepositoryCatalogRecord } from "./schema.js";

const repository: RepositoryCatalogRecord = {
  repositoryId: "repo-a",
  displayName: "Repository A",
  remoteUrl: "https://git.example.test/team/repo-a",
  checkoutPath: "/var/lib/lci/checkouts/repo-a",
  enabled: true,
  queryable: true,
  allowedPrincipals: ["team-a"],
  structuralOnly: false,
  autoIndex: false,
  lifecycle: "ready",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
};

describe("repository authorization", () => {
  it("fails closed for a configured allowlist", () => {
    expect(createRepositoryAuthorizer()(repository, "query", undefined)).toBe(false);
    expect(createRepositoryAuthorizer()(repository, "query", "other-team")).toBe(false);
    expect(createRepositoryAuthorizer()(repository, "query", "team-a")).toBe(true);
  });

  it("allows trusted local mode when no allowlist is configured", () => {
    expect(createRepositoryAuthorizer()({ ...repository, allowedPrincipals: [] }, "query", undefined)).toBe(true);
  });

  it("emits an audit event without source content", () => {
    const events: Array<{ repositoryId: string; operation: string; allowed: boolean }> = [];
    const authorizer = createRepositoryAuthorizer((event) => events.push(event));
    authorizer(repository, "index", "team-a");
    expect(events).toEqual([{ repositoryId: "repo-a", operation: "index", principal: "team-a", allowed: true }]);
  });
});
