import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
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
        limit: z.number().int().min(1).max(50).optional().default(10),
        path: z.string().optional(),
        language: z.string().optional(),
      },
    },
    async ({ query, limit, path, language }) => {
      if (!ctx.embeddingClient) {
        return {
          content: [{ type: "text", text: "lci_search is unavailable: no embedding.baseUrl is configured." }],
          isError: true,
        };
      }
      const [vector] = await ctx.embeddingClient.embed([query]);
      const hits = await ctx.codeIndex.search({ vector: vector!, limit, path, language });
      return textResult(hits);
    },
  );
}
