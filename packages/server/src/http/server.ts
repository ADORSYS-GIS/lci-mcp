import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface HttpMcpServerOptions {
  host: string;
  port: number;
  bearerToken: string;
  createMcpServer: (principal: string | undefined) => McpServer;
  onReady?: (address: string) => void;
  onError?: (error: Error) => void;
  maxSessions?: number;
  idleTimeoutMs?: number;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
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
  const maxSessions = options.maxSessions ?? 256;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
  const sessions = new Map<string, Session>();
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Route on the pathname only, so query strings (e.g. /mcp?foo=bar) are not treated as 404s.
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/healthz" && request.method === "GET") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (pathname !== "/mcp" || !["GET", "POST", "DELETE"].includes(request.method ?? "")) {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    if (!hasValidBearerToken(request, options.bearerToken)) {
      writeJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }

    const sessionId = request.headers["mcp-session-id"];
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (session) {
      session.lastActivity = Date.now();
      await session.transport.handleRequest(request, response);
      return;
    }

    // No known session. Only a POST can carry an `initialize`, so reject everything else outright.
    if (request.method !== "POST") {
      writeJson(response, 404, { error: "MCP session not found" });
      return;
    }
    // Bound the session table so an abusive or crashing client cannot grow it without limit.
    if (sessions.size >= maxSessions) {
      writeJson(response, 503, { error: "session capacity reached" }, { "retry-after": "5" });
      return;
    }
    // Create a transient server/transport for this POST. If it is a valid `initialize`,
    // onsessioninitialized registers it below; otherwise it is never stored and we close it after
    // the response so a non-initialize POST cannot leak a connected McpServer + transport.
    let registered = false;
    const transport = new StreamableHTTPServerTransport({
      onsessioninitialized: (initializedSessionId) => {
        registered = true;
        sessions.set(initializedSessionId, { server: mcpServer, transport, lastActivity: Date.now() });
      },
      onsessionclosed: (closedSessionId) => {
        const closed = sessions.get(closedSessionId);
        sessions.delete(closedSessionId);
        void closed?.server.close();
      },
    });
    // Identity is asserted by the trusted gateway in front of this server, one session per client.
    const principalHeader = request.headers["x-lci-principal"];
    const principal = Array.isArray(principalHeader) ? principalHeader[0] : principalHeader;
    const mcpServer = options.createMcpServer(principal);
    await mcpServer.connect(transport);
    try {
      await transport.handleRequest(request, response);
    } finally {
      if (!registered) {
        await transport.close().catch(() => {});
        await mcpServer.close().catch(() => {});
      }
    }
  };

  const httpServer = createHttpServer((request, response) => {
    // Never let a rejected handler become an unhandled rejection that crashes the process.
    handleRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        writeJson(response, 500, { error: "internal error" });
      } else {
        response.end();
      }
      process.stderr.write(`lci-mcp http: request failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });

  // Expire idle sessions so long-lived but abandoned streams cannot pin server + transport forever.
  const sweeper = setInterval(
    () => {
      const cutoff = Date.now() - idleTimeoutMs;
      for (const [id, session] of sessions) {
        if (session.lastActivity <= cutoff) {
          sessions.delete(id);
          void session.transport.close().catch(() => {});
          void session.server.close().catch(() => {});
        }
      }
    },
    Math.max(1_000, Math.floor(idleTimeoutMs / 2)),
  );
  // Do not let the sweep timer keep the event loop (and therefore the process) alive on its own.
  sweeper.unref();

  // On shutdown, tear down every live session so open SSE streams cannot keep the process running.
  httpServer.on("close", () => {
    clearInterval(sweeper);
    for (const [id, session] of sessions) {
      sessions.delete(id);
      void session.transport.close().catch(() => {});
      void session.server.close().catch(() => {});
    }
  });

  httpServer.listen(options.port, options.host, () => {
    const address = `http://${options.host}:${options.port}/mcp`;
    options.onReady?.(address);
  });
  // Bind failures (EADDRINUSE/EACCES) are emitted asynchronously after listen() returns, outside
  // main()'s promise chain; without a listener Node re-throws and crashes. Surface it to the caller
  // so startup can report it and exit non-zero instead.
  httpServer.on("error", (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (options.onError) options.onError(normalized);
    else process.stderr.write(`lci-mcp http: server error: ${normalized.message}\n`);
  });
  return httpServer;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}
