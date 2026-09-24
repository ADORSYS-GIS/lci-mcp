import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "../context.js";
import { textResult } from "../toolResult.js";

/** Lists only repository metadata safe for MCP discovery; paths and policy remain internal. */
export function registerRepositoriesTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_repositories",
    {
      description: "Lists repositories visible to this MCP client with safe lifecycle and queryability metadata.",
      inputSchema: {},
    },
    async () => {
      if (ctx.listRepositories) return textResult(await ctx.listRepositories(ctx.principal));
      return textResult([
        {
          repositoryId: ctx.defaultRepositoryId ?? "default",
          displayName: "current repository",
          enabled: true,
          queryable: true,
          kind: "code",
          lifecycle: "ready",
        },
      ]);
    },
  );
}
