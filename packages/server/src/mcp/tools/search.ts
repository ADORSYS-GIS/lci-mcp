import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { repositoryEnvelope, resolveToolWorker } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_search` tool registration. Returns evidence, not a generated answer. */
export function registerSearchTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_search",
    {
      description:
        "Semantic code/document search over the local index. Returns ranked chunks with source locations and node ids for follow-up structural exploration.",
      inputSchema: {
        query: z.string(),
        repository_id: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional().default(10),
        path: z.string().optional(),
        language: z.string().optional(),
      },
    },
    async ({ query, repository_id, limit, path, language }) => {
      const { worker, explicit } = await resolveToolWorker(ctx, repository_id);
      if (!worker.embeddingClient) {
        return {
          content: [{ type: "text", text: "lci_search is unavailable: no embedding.baseUrl is configured." }],
          isError: true,
        };
      }
      const [vector] = await worker.embeddingClient.embed([query]);
      const hits = await worker.codeIndex.search({ vector: vector!, limit, path, language });
      return textResult(explicit ? repositoryEnvelope(worker, hits) : hits);
    },
  );
}
