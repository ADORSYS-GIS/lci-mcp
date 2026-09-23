import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { embeddingFingerprintFor, repositoryEnvelope, resolveToolWorker } from "../context.js";
import { textResult } from "../toolResult.js";

/** `lci_index_status` tool registration. */
export function registerIndexStatusTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_index_status",
    {
      description: "Returns index lifecycle, freshness, and statistics for a selected repository.",
      inputSchema: { repository_id: z.string().optional() },
    },
    async ({ repository_id }) => {
      const { worker, explicit } = await resolveToolWorker(ctx, repository_id, "status");
      const status = await worker.codeIndex.status(embeddingFingerprintFor(ctx, worker));
      return textResult(explicit ? repositoryEnvelope(worker, status) : status);
    },
  );
}
