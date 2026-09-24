import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { hasValidBearerToken, startHttpMcpServer } from "./server.js";

describe("HTTP MCP authentication", () => {
  it("accepts only an exact bearer token", () => {
    expect(
      hasValidBearerToken({ headers: { authorization: "Bearer a-secret-token-1234" } } as never, "a-secret-token-1234"),
    ).toBe(true);
    expect(
      hasValidBearerToken({ headers: { authorization: "Bearer wrong-token" } } as never, "a-secret-token-1234"),
    ).toBe(false);
    expect(hasValidBearerToken({ headers: {} } as never, "a-secret-token-1234")).toBe(false);
  });
});

describe("HTTP MCP routing", () => {
  async function withServer(run: (port: number) => Promise<void>): Promise<void> {
    const server = startHttpMcpServer({
      host: "127.0.0.1",
      port: 0,
      bearerToken: "a-secret-token-1234",
      createMcpServer: () => ({}) as never,
    });
    await once(server, "listening");
    try {
      await run((server.address() as AddressInfo).port);
    } finally {
      server.close();
    }
  }

  function get(port: number, requestPath: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: requestPath, method: "GET", headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("routes on the pathname so /mcp with a query string is authenticated, not 404'd", async () => {
    await withServer(async (port) => {
      expect(await get(port, "/healthz")).toBe(200);
      expect(await get(port, "/nope")).toBe(404);
      // With a query string and no token this must reach auth (401), not be rejected as 404.
      expect(await get(port, "/mcp?foo=bar")).toBe(401);
      expect(await get(port, "/mcp", { authorization: "Bearer wrong" })).toBe(401);
    });
  });
});
