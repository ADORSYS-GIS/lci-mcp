import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpMcpServerOptions {
  host: string;
  port: number;
  bearerToken: string;
  createMcpServer: () => McpServer;
  onReady?: (address: string) => void;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export function hasValidBearerToken(request: IncomingMessage, expectedToken: string): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function startHttpMcpServer(options: HttpMcpServerOptions): Server {
  if (options.bearerToken.length < 16) throw new Error("HTTP bearer token must be at least 16 characters");
  const sessions = new Map<string, Session>();
  const httpServer = createHttpServer(async (request, response) => {
    if (request.url === "/healthz" && request.method === "GET") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.url !== "/mcp" || !["GET", "POST", "DELETE"].includes(request.method ?? "")) {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    if (!hasValidBearerToken(request, options.bearerToken)) {
      writeJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }

    const sessionId = request.headers["mcp-session-id"];
    let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "MCP session not found" });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, { server: mcpServer, transport });
        },
        onsessionclosed: (closedSessionId) => {
          sessions.delete(closedSessionId);
        },
      });
      const mcpServer = options.createMcpServer();
      session = { server: mcpServer, transport };
      await mcpServer.connect(transport);
    }
    await session.transport.handleRequest(request, response);
  });

  httpServer.listen(options.port, options.host, () => {
    const address = `http://${options.host}:${options.port}/mcp`;
    options.onReady?.(address);
  });
  return httpServer;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(statusCode, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}