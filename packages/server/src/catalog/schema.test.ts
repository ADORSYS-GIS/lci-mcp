import { describe, expect, it } from "vitest";

import {
  assertLifecycleTransition,
  migrateCatalogDocument,
  parseCatalogDocument,
  RepositoryCatalogRecordSchema,
  toSafeRepositorySummary,
} from "./schema.js";

const validRepository = {
  repositoryId: "aspsp-xs2a",
  displayName: "ASPSP XS2A",
  remoteUrl: "https://git.example.test/team/aspsp-xs2a",
  checkoutPath: "/var/lib/lci/checkouts/aspsp-xs2a",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
};

describe("RepositoryCatalogRecordSchema", () => {
  it("accepts a valid opaque repository record", () => {
    expect(RepositoryCatalogRecordSchema.parse(validRepository).repositoryId).toBe("aspsp-xs2a");
  });

  it("rejects malformed IDs and IDs that look like paths", () => {
    expect(() => RepositoryCatalogRecordSchema.parse({ ...validRepository, repositoryId: "../repo" })).toThrow();
    expect(() => RepositoryCatalogRecordSchema.parse({ ...validRepository, repositoryId: "Display Name" })).toThrow();
  });

  it("rejects credentials embedded in remote URLs", () => {
    expect(() =>
      RepositoryCatalogRecordSchema.parse({
        ...validRepository,
        remoteUrl: "https://user:secret@git.example.test/repo",
      }),
    ).toThrow();
  });

  it("rejects missing or relative checkout paths", () => {
    expect(() => RepositoryCatalogRecordSchema.parse({ ...validRepository, checkoutPath: "checkouts/repo" })).toThrow();
    expect(() => RepositoryCatalogRecordSchema.parse({ ...validRepository, checkoutPath: undefined })).toThrow();
  });
});

describe("catalog migration and lifecycle", () => {
  it("migrates the version zero envelope", () => {
    expect(migrateCatalogDocument({ schemaVersion: 0, repositories: [] })).toEqual({
      schemaVersion: 1,
      repositories: [],
    });
  });

  it("rejects duplicate IDs in a catalog document", () => {
    expect(() => parseCatalogDocument({ schemaVersion: 1, repositories: [validRepository, validRepository] })).toThrow(
      "duplicate repository IDs",
    );
  });

  it("allows normal indexing transitions and rejects unsafe jumps", () => {
    expect(() => assertLifecycleTransition("registered", "provisioning")).not.toThrow();
    expect(() => assertLifecycleTransition("indexing", "ready")).not.toThrow();
    expect(() => assertLifecycleTransition("registered", "ready")).toThrow(/invalid repository lifecycle transition/);
  });

  it("returns a safe summary without checkout or policy details", () => {
    const record = RepositoryCatalogRecordSchema.parse(validRepository);
    const summary = toSafeRepositorySummary(record);
    expect(summary).not.toHaveProperty("checkoutPath");
    expect(summary).not.toHaveProperty("allowedPrincipals");
    expect(summary.repositoryId).toBe(record.repositoryId);
  });
});
