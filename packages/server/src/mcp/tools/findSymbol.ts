import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { repositoryEnvelope, resolveToolWorker } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_find_symbol` tool registration. */
export function registerFindSymbolTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_find_symbol",
    {
      description: "Finds structural symbols in a selected repository by name/label/path substring (case-insensitive).",
      inputSchema: {
        repository_id: z.string().optional(),
        term: z.string(),
        limit: z.number().int().min(1).max(200).optional().default(20),
      },
    },
    async ({ repository_id, term, limit }) => {
      const { worker, explicit } = await resolveToolWorker(ctx, repository_id);
      const results = await worker.codeIndex.findSymbol({ term, limit });
      return textResult(explicit ? repositoryEnvelope(worker, results) : results);
    },
  );
}
