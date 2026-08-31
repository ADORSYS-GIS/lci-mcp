import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_get_callees` tool registration. Bounded, single-hop forward `calls` traversal. */
export function registerCalleesTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_get_callees",
    {
      description: "Returns direct callees of the given node id (forward call-graph edges).",
      inputSchema: {
        nodeId: z.string(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async ({ nodeId, limit }) => textResult(await ctx.codeIndex.callees({ nodeId, limit })),
  );
}
