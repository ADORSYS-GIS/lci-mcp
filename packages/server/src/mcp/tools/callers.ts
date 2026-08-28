import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_get_callers` tool registration. Bounded, single-hop reverse `calls` traversal. */
export function registerCallersTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_get_callers",
    {
      description: "Returns direct callers of the given node id (reverse call-graph edges).",
      inputSchema: {
        nodeId: z.string(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async ({ nodeId, limit }) => textResult(await ctx.codeIndex.callers({ nodeId, limit })),
  );
}
