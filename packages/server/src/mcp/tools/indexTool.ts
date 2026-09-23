import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { type AppContext, embeddingFingerprintFor, repositoryEnvelope, resolveToolWorker, type ToolWorker } from "../context.js";
import { startBackgroundIndexJob } from "../indexingJob.js";
import { textResult } from "../toolResult.js";

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
      const embeddingFingerprint = embeddingFingerprintFor(ctx, worker);

      const handle = await worker.codeIndex.beginIndex({
        embeddingFingerprint,
        embeddingDimensions: ctx.config.embedding.dimensions,
      });

      if (!worker.embeddingClient) {
        await worker.codeIndex.commitIndex(handle.generationId);
        const result = { generationId: handle.generationId, state: "done" };
        return textResult(explicit ? repositoryEnvelope(worker, result) : result);
      }

      startBackgroundIndexJob(ctx.logger, worker.repository.repositoryId, () =>
        runEmbeddingLoopAndCommit(ctx, worker, handle.generationId),
      );
      const result = { generationId: handle.generationId, state: "in_progress" };
      return textResult(explicit ? repositoryEnvelope(worker, result) : result);
    },
  );
}

async function runEmbeddingLoopAndCommit(ctx: AppContext, worker: ToolWorker, generationId: string): Promise<void> {
  const batchSize = ctx.config.embedding.batchSize;
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
    ctx.logger.info("index generation committed", { generationId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.logger.error("index generation failed", { generationId, reason });
    await worker.codeIndex.failIndex(generationId, reason);
  }
}
