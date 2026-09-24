import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RepositoryLifecycle } from "../../catalog/schema.js";
import {
  type AppContext,
  embeddingFingerprintFor,
  repositoryEnvelope,
  resolveToolWorker,
  type ToolWorker,
} from "../context.js";
import { isIndexJobInFlight, startBackgroundIndexJob } from "../indexingJob.js";
import { textResult } from "../toolResult.js";

// Lifecycle bookkeeping is best-effort: a stale in-memory snapshot must never fail an index run.
async function markLifecycle(
  ctx: AppContext,
  repositoryId: string,
  lifecycle: RepositoryLifecycle,
  patch: Parameters<NonNullable<AppContext["catalog"]>["transition"]>[2] = {},
): Promise<void> {
  if (!ctx.catalog) return;
  try {
    await ctx.catalog.transition(repositoryId, lifecycle, patch);
  } catch (error) {
    ctx.logger.warn("catalog lifecycle update skipped", {
      repositoryId,
      lifecycle,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** `lci_index` tool registration. */
export function registerIndexTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_index",
    {
      description:
        "Indexes or reindexes a selected repository. Returns once structural extraction completes; " +
        "if embeddings are configured, they continue building in the background — poll lci_index_status " +
        "for completion. Never destroys the previously active index on failure. Rejected while a " +
        "previous call from this process is still building — poll lci_index_status and retry once it " +
        "reports done.",
      inputSchema: { repository_id: z.string().optional() },
    },
    async ({ repository_id }) => {
      const { worker, explicit } = await resolveToolWorker(ctx, repository_id, "index");
      const repositoryId = worker.repository.repositoryId;
      // Reject before beginIndex so we never create a BUILDING generation (holding a lease) that no
      // background job will process because the existing job blocks a new one.
      if (worker.embeddingClient && isIndexJobInFlight(repositoryId)) {
        throw new Error(`repository indexing already in progress: ${repositoryId}`);
      }
      const embeddingFingerprint = embeddingFingerprintFor(ctx, worker);

      const handle = await worker.codeIndex.beginIndex({
        embeddingFingerprint,
        embeddingDimensions: ctx.config.embedding.dimensions,
      });
      await markLifecycle(ctx, repositoryId, "indexing");

      if (!worker.embeddingClient) {
        await worker.codeIndex.commitIndex(handle.generationId);
        await markLifecycle(ctx, repositoryId, "ready", { queryable: true, lastIndexedAt: new Date().toISOString() });
        const result = { generationId: handle.generationId, state: "done" };
        return textResult(explicit ? repositoryEnvelope(worker, result) : result);
      }

      startBackgroundIndexJob(ctx.logger, repositoryId, () =>
        runEmbeddingLoopAndCommit(ctx, worker, handle.generationId),
      );
      const result = { generationId: handle.generationId, state: "in_progress" };
      return textResult(explicit ? repositoryEnvelope(worker, result) : result);
    },
  );
}

async function runEmbeddingLoopAndCommit(ctx: AppContext, worker: ToolWorker, generationId: string): Promise<void> {
  const batchSize = ctx.config.embedding.batchSize;
  const repositoryId = worker.repository.repositoryId;
  try {
    for (;;) {
      const batch = await worker.codeIndex.nextEmbeddingBatch(generationId, batchSize);
      if (batch.length === 0) break;
      const vectors = await worker.embeddingClient!.embed(batch.map((item) => item.text));
      const dimensions = vectors[0]?.length ?? ctx.config.embedding.dimensions ?? 0;
      await worker.codeIndex.putEmbeddings(
        generationId,
        batch.map((item, i) => ({ id: item.id, vector: vectors[i]! })),
        dimensions,
      );
    }
    await worker.codeIndex.commitIndex(generationId);
    await markLifecycle(ctx, repositoryId, "ready", { queryable: true, lastIndexedAt: new Date().toISOString() });
    ctx.logger.info("index generation committed", { generationId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.logger.error("index generation failed", { generationId, reason });
    await worker.codeIndex.failIndex(generationId, reason);
    await markLifecycle(ctx, repositoryId, "failed", { lastError: reason });
  }
}
