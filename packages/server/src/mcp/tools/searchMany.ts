import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { repositoryEnvelope, resolveToolWorker } from "../context.js";
import { textResult } from "../toolResult.js";

const MAX_REPOSITORIES = 20;
const MAX_TOTAL_BYTES = 256_000;

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
      let totalBytes = 0;
      let totalHits = 0;

      for (const repositoryId of uniqueRepositoryIds) {
        if (totalHits >= total_limit || totalBytes >= max_total_bytes) break;
        try {
          const { worker } = await resolveToolWorker(ctx, repositoryId);
          if (!worker.embeddingClient) {
            results.push({ repository: repositoryEnvelope(worker, []).repository, error: "embeddings unavailable" });
            continue;
          }
          const [vector] = await worker.embeddingClient.embed([query]);
          const hits = await worker.codeIndex.search({ vector: vector!, limit: per_repository_limit, path, language });
          const remaining = total_limit - totalHits;
          const boundedHits = hits.slice(0, remaining).filter((hit) => {
            const hitBytes = Buffer.byteLength(JSON.stringify(hit), "utf8");
            if (totalBytes + hitBytes > max_total_bytes) return false;
            totalBytes += hitBytes;
            return true;
          });
          if (boundedHits.length > 0) {
            totalHits += boundedHits.length;
            results.push(repositoryEnvelope(worker, boundedHits));
          }
        } catch (error) {
          results.push({ repositoryId, error: error instanceof Error ? error.message : JSON.stringify(error) });
        }
      }

      return textResult({ query, results, limits: { totalLimit: total_limit, maxTotalBytes: max_total_bytes } });
    },
  );
}