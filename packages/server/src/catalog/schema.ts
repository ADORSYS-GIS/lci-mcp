import path from "node:path";

import { z } from "zod";

import { DOCUMENT_SOURCE_REMOTE_HOST } from "../documentSources.js";
import { isValidRemoteUrl, REMOTE_URL_MESSAGE } from "./remoteUrl.js";

export const CATALOG_SCHEMA_VERSION = 1;

export const RepositoryLifecycleSchema = z.enum([
  "registered",
  "provisioning",
  "indexing",
  "ready",
  "stale",
  "failed",
  "disabled",
  "removed",
]);
export type RepositoryLifecycle = z.infer<typeof RepositoryLifecycleSchema>;

const RepositoryIdSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62})$/, "repositoryId must be a stable opaque identifier")
  .refine((value) => !value.includes(".."), "repositoryId must not contain path traversal");

const RemoteUrlSchema = z.string().min(1).refine(isValidRemoteUrl, REMOTE_URL_MESSAGE);

const AbsoluteCheckoutPathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), "checkoutPath must be absolute")
  .refine((value) => !value.includes("\0"), "checkoutPath must not contain a null byte")
  .refine((value) => path.basename(path.normalize(value)) !== ".", "checkoutPath must identify a repository directory");

export const RepositoryCatalogRecordSchema = z.object({
  repositoryId: RepositoryIdSchema,
  displayName: z.string().trim().min(1).max(200),
  remoteUrl: RemoteUrlSchema,
  remoteIdentity: z.string().trim().min(1).optional(),
  checkoutPath: AbsoluteCheckoutPathSchema,
  enabled: z.boolean().default(true),
  queryable: z.boolean().default(false),
  allowedPrincipals: z.array(z.string().trim().min(1)).default([]),
  structuralOnly: z.boolean().default(false),
  autoIndex: z.boolean().default(false),
  lifecycle: RepositoryLifecycleSchema.default("registered"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastIndexedAt: z.string().datetime().optional(),
  lastError: z.string().max(2_000).optional(),
});
export type RepositoryCatalogRecord = z.infer<typeof RepositoryCatalogRecordSchema>;

export const CatalogDocumentSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  repositories: z.array(RepositoryCatalogRecordSchema),
});
export type CatalogDocument = z.infer<typeof CatalogDocumentSchema>;

export function parseCatalogDocument(value: unknown): CatalogDocument {
  const document = CatalogDocumentSchema.parse(value);
  const ids = document.repositories.map((repository) => repository.repositoryId);
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicateIds.add(id);
    seen.add(id);
  }
  if (duplicateIds.size > 0) {
    throw new Error(`duplicate repository IDs: ${[...duplicateIds].join(", ")}`);
  }
  return document;
}

export const SafeRepositorySummarySchema = z.object({
  repositoryId: RepositoryIdSchema,
  displayName: z.string(),
  remoteIdentity: z.string().optional(),
  enabled: z.boolean(),
  queryable: z.boolean(),
  kind: z.enum(["code", "document"]),
  documentLinks: z.record(z.string(), z.string()).optional(),
  lifecycle: RepositoryLifecycleSchema,
  lastIndexedAt: z.string().datetime().optional(),
});
export type SafeRepositorySummary = z.infer<typeof SafeRepositorySummarySchema>;

// Document sources are staged under the synthetic `documents.local` remote, which is how a summary
// distinguishes a background document source from a real code repository.
export function repositoryKind(remoteUrl: string): "code" | "document" {
  try {
    return new URL(remoteUrl).hostname === DOCUMENT_SOURCE_REMOTE_HOST ? "document" : "code";
  } catch {
    return "code";
  }
}

export function toSafeRepositorySummary(record: RepositoryCatalogRecord): SafeRepositorySummary {
  return {
    repositoryId: record.repositoryId,
    displayName: record.displayName,
    remoteIdentity: record.remoteIdentity,
    enabled: record.enabled,
    queryable: record.queryable,
    kind: repositoryKind(record.remoteUrl),
    lifecycle: record.lifecycle,
    lastIndexedAt: record.lastIndexedAt,
  };
}

export const LEGACY_CATALOG_SCHEMA_VERSION = 0;

type LegacyCatalogDocument = {
  schemaVersion?: 0;
  repositories?: unknown[];
};

/** Migrates only the intentionally small v0 envelope; record validation remains strict. */
export function migrateCatalogDocument(value: unknown): CatalogDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("catalog must be a JSON object");
  }

  const raw = value as LegacyCatalogDocument & { schemaVersion?: number };
  if (raw.schemaVersion === LEGACY_CATALOG_SCHEMA_VERSION) {
    return parseCatalogDocument({ schemaVersion: CATALOG_SCHEMA_VERSION, repositories: raw.repositories ?? [] });
  }
  return parseCatalogDocument(value);
}

const lifecycleTransitions: Record<RepositoryLifecycle, readonly RepositoryLifecycle[]> = {
  // A manifest that ships its own checkouts indexes straight from `registered`; provisioning is only
  // an intermediate step for deployments that clone from a remote.
  registered: ["provisioning", "indexing", "disabled", "removed"],
  provisioning: ["registered", "indexing", "failed", "disabled", "removed"],
  indexing: ["ready", "stale", "failed", "disabled", "removed"],
  ready: ["indexing", "stale", "disabled", "removed"],
  stale: ["indexing", "ready", "failed", "disabled", "removed"],
  failed: ["registered", "provisioning", "indexing", "disabled", "removed"],
  disabled: ["registered", "provisioning", "removed"],
  removed: [],
};

export function assertLifecycleTransition(from: RepositoryLifecycle, to: RepositoryLifecycle): void {
  if (from === to || lifecycleTransitions[from].includes(to)) return;
  throw new Error(`invalid repository lifecycle transition: ${from} -> ${to}`);
}
