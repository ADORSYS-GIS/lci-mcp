import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { repositoryEnvelope, resolveToolWorker } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_explore_symbol` tool registration. Symbol plus bounded neighborhood. */
export function registerExploreSymbolTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_explore_symbol",
    {
      description:
        "Returns a symbol's bounded structural neighborhood in a selected repository; caller/callee depth is clamped to 3.",
      inputSchema: {
        repository_id: z.string().optional(),
        nodeId: z.string(),
        callersDepth: z.number().int().min(0).max(3).optional().default(1),
        calleesDepth: z.number().int().min(0).max(3).optional().default(1),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async ({ repository_id, nodeId, callersDepth, calleesDepth, limit }) => {
      const { worker, explicit } = await resolveToolWorker(ctx, repository_id);
      const results = await worker.codeIndex.exploreSymbol({ nodeId, callersDepth, calleesDepth, limit });
      return textResult(explicit ? repositoryEnvelope(worker, results) : results);
    },
  );
}
