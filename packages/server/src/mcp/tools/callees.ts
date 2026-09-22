import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { repositoryEnvelope, resolveToolWorker } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_get_callees` tool registration. Bounded, single-hop forward `calls` traversal. */
export function registerCalleesTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_get_callees",
    {
      description: "Returns direct callees of a node in a selected repository (forward call-graph edges).",
      inputSchema: {
        repository_id: z.string().optional(),
        nodeId: z.string(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async ({ repository_id, nodeId, limit }) => {
      const { worker, explicit } = await resolveToolWorker(ctx, repository_id);
      const results = await worker.codeIndex.callees({ nodeId, limit });
      return textResult(explicit ? repositoryEnvelope(worker, results) : results);
    },
  );
}
