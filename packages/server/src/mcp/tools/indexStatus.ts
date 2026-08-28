import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_index_status` tool registration. */
export function registerIndexStatusTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_index_status",
    {
      description: "Returns index lifecycle, freshness, and statistics for the current repository.",
      inputSchema: {},
    },
    async () => textResult(await ctx.codeIndex.status()),
  );
}
