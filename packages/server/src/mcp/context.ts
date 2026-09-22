import type { SafeRepositorySummary } from "../catalog/schema.js";
import type { RepositoryWorker, RepositoryWorkerRegistry, WorkerOperation } from "../catalog/workerRegistry.js";
import type { LciConfig } from "../config/schema.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { CodeIndex } from "../engine.js";
import type { Logger } from "../logging.js";

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
  defaultRepositoryId?: string;
  allowImplicitRepository?: boolean;
  listRepositories?: () => Promise<SafeRepositorySummary[]>;
}

export async function resolveToolWorker(
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
    return { worker: await ctx.workerRegistry.resolve(selectedId, operation), explicit: repositoryId !== undefined };
  }

  if (repositoryId !== undefined && repositoryId !== ctx.defaultRepositoryId) {
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
        allowedPrincipals: [],
        embeddingProfile: "default",
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
      lifecycle: worker.repository.lifecycle,
      lastIndexedAt: worker.repository.lastIndexedAt,
    },
    results,
  };
}
