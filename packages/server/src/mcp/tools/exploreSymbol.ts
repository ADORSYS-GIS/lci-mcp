import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_explore_symbol` tool registration. Symbol plus bounded neighborhood. */
export function registerExploreSymbolTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_explore_symbol",
    {
      description:
        "Returns a symbol's immediate structural neighborhood: nearby nodes and the calls edges among them, out to the given caller/callee depth (each clamped to 3).",
      inputSchema: {
        nodeId: z.string(),
        callersDepth: z.number().int().min(0).max(3).optional().default(1),
        calleesDepth: z.number().int().min(0).max(3).optional().default(1),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async ({ nodeId, callersDepth, calleesDepth, limit }) =>
      textResult(await ctx.codeIndex.exploreSymbol({ nodeId, callersDepth, calleesDepth, limit })),
  );
}
