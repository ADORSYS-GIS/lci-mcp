import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "./context.js";
import { registerCalleesTool } from "./tools/callees.js";
import { registerCallersTool } from "./tools/callers.js";
import { registerExploreSymbolTool } from "./tools/exploreSymbol.js";
import { registerFindSymbolTool } from "./tools/findSymbol.js";
import { registerIndexStatusTool } from "./tools/indexStatus.js";
import { registerIndexTool } from "./tools/indexTool.js";
import { registerSearchTool } from "./tools/search.js";

/** A deliberately small, semantic tool surface — never raw SQL or graph-query access. */
export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "lightbridge-code-intelligence", version: "0.1.0" });

  registerIndexTool(server, ctx);
  registerIndexStatusTool(server, ctx);
  registerSearchTool(server, ctx);
  registerFindSymbolTool(server, ctx);
  registerCallersTool(server, ctx);
  registerCalleesTool(server, ctx);
  registerExploreSymbolTool(server, ctx);

  return server;
}
