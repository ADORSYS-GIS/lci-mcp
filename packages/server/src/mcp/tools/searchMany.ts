import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext, ToolWorker } from "../context.js";
import { repositoryEnvelope, resolveToolWorker } from "../context.js";
import { sanitizeToolError, textResult } from "../toolResult.js";

const MAX_REPOSITORIES = 20;
const MAX_TOTAL_BYTES = 256_000;

interface RepositorySearchOutcome {
  repositoryId: string;
  worker?: ToolWorker;
  hits?: unknown[];
  error?: string;
}

/** Explicit, bounded semantic fan-out. Structural follow-up remains repository-scoped. */
export function registerSearchManyTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_search_many",
    {
      description:
        "Searches explicitly selected repositories with bounded fan-out. Results retain repository and revision provenance; use repository_id for structural follow-up.",
      inputSchema: {
        repository_ids: z.array(z.string()).min(1).max(MAX_REPOSITORIES),
        query: z.string(),
        per_repository_limit: z.number().int().min(1).max(50).optional().default(10),
        total_limit: z.number().int().min(1).max(100).optional().default(50),
        max_total_bytes: z.number().int().min(1_000).max(MAX_TOTAL_BYTES).optional().default(MAX_TOTAL_BYTES),
        path: z.string().optional(),
        language: z.string().optional(),
      },
    },
    async ({ repository_ids, query, per_repository_limit, total_limit, max_total_bytes, path, language }) => {
      const uniqueRepositoryIds = [...new Set(repository_ids)];
      const results: Array<unknown> = [];

      // Embed the query once — the model is repository-agnostic, so re-embedding per repository is
      // pure waste. Without an embedding client, semantic fan-out is unavailable everywhere.
      if (!ctx.embeddingClient) {
        for (const repositoryId of uniqueRepositoryIds) results.push({ repositoryId, error: "embeddings unavailable" });
        return textResult({ query, results, limits: { totalLimit: total_limit, maxTotalBytes: max_total_bytes } });
      }
      const [vector] = await ctx.embeddingClient.embed([query]);

      // Fan out in capacity-sized batches: within a batch we never exceed the worker cap, so the
      // registry's LRU eviction can only reclaim workers between batches, never one mid-search.
      const batchSize = Math.max(1, ctx.workerRegistry?.capacity ?? 1);
      const outcomes: RepositorySearchOutcome[] = [];
      for (let start = 0; start < uniqueRepositoryIds.length; start += batchSize) {
        const batch = uniqueRepositoryIds.slice(start, start + batchSize);
        const batchOutcomes = await Promise.all(
          batch.map(async (repositoryId): Promise<RepositorySearchOutcome> => {
            try {
              const { worker } = await resolveToolWorker(ctx, repositoryId);
              if (!worker.embeddingClient) return { repositoryId, worker, error: "embeddings unavailable" };
              const hits = await worker.codeIndex.search({
                vector: vector!,
                limit: per_repository_limit,
                path,
                language,
              });
              return { repositoryId, worker, hits };
            } catch (error) {
              return { repositoryId, error: sanitizeToolError(error) };
            }
          }),
        );
        outcomes.push(...batchOutcomes);
      }

      // Apply the global hit/byte budget deterministically over the collected (order-preserved) results.
      let totalBytes = 0;
      let totalHits = 0;
      for (const outcome of outcomes) {
        if (outcome.error) {
          const repository = outcome.worker ? repositoryEnvelope(outcome.worker, []).repository : undefined;
          results.push(
            repository
              ? { repository, error: outcome.error }
              : { repositoryId: outcome.repositoryId, error: outcome.error },
          );
          continue;
        }
        if (totalHits >= total_limit || totalBytes >= max_total_bytes) continue;
        const remaining = total_limit - totalHits;
        const boundedHits = (outcome.hits ?? []).slice(0, remaining).filter((hit) => {
          const hitBytes = Buffer.byteLength(JSON.stringify(hit), "utf8");
          if (totalBytes + hitBytes > max_total_bytes) return false;
          totalBytes += hitBytes;
          return true;
        });
        if (boundedHits.length > 0) {
          totalHits += boundedHits.length;
          results.push(repositoryEnvelope(outcome.worker!, boundedHits));
        }
      }

      return textResult({ query, results, limits: { totalLimit: total_limit, maxTotalBytes: max_total_bytes } });
    },
  );
}
