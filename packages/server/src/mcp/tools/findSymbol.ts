import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_find_symbol` tool registration. */
export function registerFindSymbolTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_find_symbol",
    {
      description: "Finds structural symbols by name/label/path substring (case-insensitive).",
      inputSchema: {
        term: z.string(),
        limit: z.number().int().min(1).max(200).optional().default(20),
      },
    },
    async ({ term, limit }) => textResult(await ctx.codeIndex.findSymbol({ term, limit })),
  );
}
