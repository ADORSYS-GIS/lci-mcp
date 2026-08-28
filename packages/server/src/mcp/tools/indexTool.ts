import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { startBackgroundIndexJob } from "../indexingJob.js";
import { textResult } from "../toolResult.js";

/** `lci_index` tool registration. */
export function registerIndexTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_index",
    {
      description:
        "Indexes or reindexes the current repository. Returns once structural extraction completes; " +
        "if embeddings are configured, they continue building in the background — poll lci_index_status " +
        "for completion. Never destroys the previously active index on failure.",
      inputSchema: { force: z.boolean().optional().default(false) },
    },
    async () => {
      const embeddingFingerprint = ctx.embeddingClient
        ? `${ctx.config.embedding.model}:${ctx.config.embedding.dimensions ?? "default"}`
        : undefined;

      const handle = await ctx.codeIndex.beginIndex({
        embeddingFingerprint,
        embeddingDimensions: ctx.config.embedding.dimensions,
      });

      if (!ctx.embeddingClient) {
        await ctx.codeIndex.commitIndex(handle.generationId);
        return textResult({ generationId: handle.generationId, state: "done" });
      }

      startBackgroundIndexJob(ctx.logger, () => runEmbeddingLoopAndCommit(ctx, handle.generationId));
      return textResult({ generationId: handle.generationId, state: "in_progress" });
    },
  );
}

async function runEmbeddingLoopAndCommit(ctx: AppContext, generationId: string): Promise<void> {
  const batchSize = ctx.config.embedding.batchSize;
  try {
    for (;;) {
      const batch = await ctx.codeIndex.nextEmbeddingBatch(generationId, batchSize);
      if (batch.length === 0) break;
      const vectors = await ctx.embeddingClient!.embed(batch.map((item) => item.text));
      const dimensions = vectors[0]?.length ?? ctx.config.embedding.dimensions ?? 0;
      await ctx.codeIndex.putEmbeddings(
        generationId,
        batch.map((item, i) => ({ id: item.id, vector: vectors[i]! })),
        dimensions,
      );
    }
    await ctx.codeIndex.commitIndex(generationId);
    ctx.logger.info("index generation committed", { generationId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.logger.error("index generation failed", { generationId, reason });
    await ctx.codeIndex.failIndex(generationId, reason);
  }
}
