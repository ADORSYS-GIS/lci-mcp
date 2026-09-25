import { createHash } from "node:crypto";

import type { SafeRepositorySummary } from "../catalog/schema.js";
import { repositoryKind } from "../catalog/schema.js";
import type { RepositoryCatalogStore } from "../catalog/store.js";
import type { RepositoryWorker, RepositoryWorkerRegistry, WorkerOperation } from "../catalog/workerRegistry.js";
import type { LciConfig } from "../config/schema.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { CodeIndex } from "../engine.js";
import type { Logger } from "../logging.js";
import { sanitizeToolError } from "./toolResult.js";

export type ToolWorker = Pick<
  RepositoryWorker,
  "codeIndex" | "embeddingClient" | "repository" | "repositoryRoot" | "databasePath"
>;

/** Shared state every tool handler needs — built once in cli.ts, passed into createServer. */
export interface AppContext {
  /** Legacy single-repository fields remain during the compatibility migration. */
  codeIndex?: CodeIndex;
  embeddingClient?: EmbeddingClient;
  config: LciConfig;
  logger: Logger;
  repoRoot: string;
  databasePath: string;
  workerRegistry?: RepositoryWorkerRegistry;
  /** Persistent catalog, used to advance repository lifecycle/queryability as indexing progresses. */
  catalog?: RepositoryCatalogStore;
  defaultRepositoryId?: string;
  allowImplicitRepository?: boolean;
  listRepositories?: () => Promise<SafeRepositorySummary[]>;
}

export async function resolveToolWorker(
  ctx: AppContext,
  repositoryId: string | undefined,
  operation: WorkerOperation = "query",
): Promise<{ worker: ToolWorker; explicit: boolean }> {
  // Shared error chokepoint: catalog reads and CodeIndex.open (reached via the registry) throw
  // messages embedding absolute filesystem paths. Sanitize once here so no repository-scoped tool
  // can leak those back through the MCP response; the raw detail stays in the server debug log.
  try {
    return await resolveToolWorkerRaw(ctx, repositoryId, operation);
  } catch (error) {
    ctx.logger.debug("resolveToolWorker failed", {
      repositoryId,
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw new Error(sanitizeToolError(error));
  }
}

async function resolveToolWorkerRaw(
  ctx: AppContext,
  repositoryId: string | undefined,
  operation: WorkerOperation = "query",
): Promise<{ worker: ToolWorker; explicit: boolean }> {
  if (ctx.workerRegistry) {
    const selectedId = repositoryId ?? ctx.defaultRepositoryId;
    if (selectedId === undefined) throw new Error("repository_id is required for this MCP server");
    if (repositoryId === undefined && ctx.allowImplicitRepository !== true) {
      throw new Error("repository_id is required for this MCP server");
    }
    return {
      worker: await ctx.workerRegistry.resolve(selectedId, operation),
      explicit: repositoryId !== undefined,
    };
  }

  if (repositoryId !== undefined && repositoryId !== ctx.defaultRepositoryId && repositoryId !== "default") {
    throw new Error(`repository is not configured: ${repositoryId}`);
  }
  if (ctx.allowImplicitRepository === false && repositoryId === undefined) {
    throw new Error("repository_id is required for this MCP server");
  }
  if (!ctx.codeIndex) throw new Error("legacy repository worker is not initialized");
  return {
    worker: {
      codeIndex: ctx.codeIndex,
      embeddingClient: ctx.embeddingClient,
      repository: {
        repositoryId: ctx.defaultRepositoryId ?? "default",
        displayName: ctx.defaultRepositoryId ?? "current repository",
        remoteUrl: "https://invalid.local/legacy",
        checkoutPath: ctx.repoRoot,
        enabled: true,
        queryable: true,
        structuralOnly: ctx.embeddingClient === undefined,
        autoIndex: false,
        lifecycle: "ready",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      repositoryRoot: ctx.repoRoot,
      databasePath: ctx.databasePath,
    },
    explicit: repositoryId !== undefined,
  };
}

// Identifies the embedding model/config a worker would build with now; `undefined` when the
// worker has no embedding client (structural-only). Shared by lci_index and lci_index_status so
// the "expected" fingerprint used to (re)build and the one used to detect staleness never drift.
// baseUrl is included so repointing to a different provider (same model/dimensions) is caught;
// the tuple is hashed so a URL's own delimiters can't collide with another configuration.
export function embeddingFingerprintFor(ctx: AppContext, worker: ToolWorker): string | undefined {
  if (!worker.embeddingClient) return undefined;
  const { baseUrl, model, dimensions } = ctx.config.embedding;
  return createHash("sha256")
    .update(JSON.stringify({ baseUrl: baseUrl ?? null, model, dimensions: dimensions ?? null }))
    .digest("hex");
}

export function repositoryEnvelope<T>(
  worker: ToolWorker,
  results: T,
): { repository: SafeRepositorySummary; results: T } {
  return {
    repository: {
      repositoryId: worker.repository.repositoryId,
      displayName: worker.repository.displayName,
      remoteIdentity: worker.repository.remoteIdentity,
      enabled: worker.repository.enabled,
      queryable: worker.repository.queryable,
      kind: repositoryKind(worker.repository.remoteUrl),
      lifecycle: worker.repository.lifecycle,
      lastIndexedAt: worker.repository.lastIndexedAt,
    },
    results,
  };
}
