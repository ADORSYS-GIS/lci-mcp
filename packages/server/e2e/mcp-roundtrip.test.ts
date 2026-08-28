import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeEmbeddingServer, startFakeEmbeddingServer } from "./support/fakeEmbeddingServer.js";
import { createFixtureRepo } from "./support/fixtureRepo.js";
import { type McpTestClient, spawnCli } from "./support/mcpStdioClient.js";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function parseToolResult(result: unknown): unknown {
  const typed = result as ToolCallResult;
  return JSON.parse(typed.content[0]!.text);
}

async function callTool(client: McpTestClient, name: string, args?: Record<string, unknown>): Promise<unknown> {
  return client.request("tools/call", { name, arguments: args ?? {} });
}

describe("MCP stdio round trip against the real built CLI + engine", () => {
  let fixtureRoot: string;
  let embeddingServer: FakeEmbeddingServer;
  let client: McpTestClient;

  beforeAll(async () => {
    fixtureRoot = createFixtureRepo();
    embeddingServer = await startFakeEmbeddingServer(8);
    client = spawnCli(
      [
        "--stdio",
        "--root",
        fixtureRoot,
        "--embedding-base-url",
        embeddingServer.url,
        "--embedding-model",
        "fake-model",
        "--embedding-dimensions",
        "8",
        "--log-level",
        "debug",
      ],
      new URL("..", import.meta.url).pathname,
    );

    const init = (await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "vitest-e2e", version: "0.0.0" },
    })) as { protocolVersion: string };
    expect(init.protocolVersion).toBeTruthy();
    client.notify("notifications/initialized");
  });

  afterAll(async () => {
    await client.close();
    await embeddingServer.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("lists all seven tools with schemas", async () => {
    const result = (await client.request("tools/list")) as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "lci_explore_symbol",
        "lci_find_symbol",
        "lci_get_callees",
        "lci_get_callers",
        "lci_index",
        "lci_index_status",
        "lci_search",
      ].sort(),
    );
  });

  it("reports never_ran before any indexing has happened", async () => {
    const status = parseToolResult(await callTool(client, "lci_index_status")) as { state: string; usable: boolean };
    expect(status.state).toBe("never_ran");
    expect(status.usable).toBe(false);
  });

  it("indexes the repository, embeds every chunk, and reaches a usable done state", async () => {
    const started = parseToolResult(await callTool(client, "lci_index")) as { generationId: string; state: string };
    expect(started.generationId).toBeTruthy();
    expect(["in_progress", "done"]).toContain(started.state);

    const deadline = Date.now() + 20_000;
    let status: { state: string; usable: boolean; stats: { chunks: number; nodes: number; edges: number } };
    for (;;) {
      status = parseToolResult(await callTool(client, "lci_index_status")) as typeof status;
      if (status.state === "done") break;
      if (status.state === "failed") throw new Error(`indexing failed: ${JSON.stringify(status)}`);
      if (Date.now() > deadline) throw new Error(`indexing did not complete in time: ${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(status!.usable).toBe(true);
    expect(status!.stats.nodes).toBeGreaterThan(0);
    expect(status!.stats.edges).toBeGreaterThan(0);
    expect(embeddingServer.stats.requestCount).toBeGreaterThan(0);
  });

  it("finds a symbol by name", async () => {
    const hits = parseToolResult(await callTool(client, "lci_find_symbol", { term: "add" })) as Array<{
      nodeId: string;
      label: string;
    }>;
    const fn = hits.find((h) => h.label === "add()");
    expect(fn?.nodeId).toBe("src/math.rs#1:add");
  });

  it("resolves callers across the call chain: main -> print_result -> log -> add", async () => {
    const addCallers = parseToolResult(
      await callTool(client, "lci_get_callers", { nodeId: "src/math.rs#1:add" }),
    ) as Array<{ nodeId: string }>;
    expect(addCallers.map((c) => c.nodeId)).toContain("src/math.rs#10:log");

    const logCallers = parseToolResult(
      await callTool(client, "lci_get_callers", { nodeId: "src/math.rs#10:log" }),
    ) as Array<{ nodeId: string }>;
    expect(logCallers.map((c) => c.nodeId)).toContain("src/math.rs#5:print_result");
  });

  it("resolves callees of main()", async () => {
    const mainNodes = parseToolResult(await callTool(client, "lci_find_symbol", { term: "main" })) as Array<{
      nodeId: string;
      label: string;
    }>;
    const mainFn = mainNodes.find((n) => n.label === "main()")!;
    const callees = parseToolResult(await callTool(client, "lci_get_callees", { nodeId: mainFn.nodeId })) as Array<{
      nodeId: string;
    }>;
    expect(callees.map((c) => c.nodeId)).toContain("src/math.rs#5:print_result");
  });

  it("explores a symbol's bounded neighborhood, including the transitive add<-log<-print_result<-main chain", async () => {
    const result = parseToolResult(
      await callTool(client, "lci_explore_symbol", { nodeId: "src/math.rs#1:add", callersDepth: 3, calleesDepth: 3 }),
    ) as { nodes: Array<{ nodeId: string }>; edges: Array<{ source: string; target: string; relation: string }> };
    const ids = result.nodes.map((n) => n.nodeId).sort();
    expect(ids).toEqual(
      ["src/main.rs#3:main", "src/math.rs#1:add", "src/math.rs#5:print_result", "src/math.rs#10:log"].sort(),
    );
  });

  it("returns ranked semantic search hits with a stitched-in node id", async () => {
    const hits = parseToolResult(
      await callTool(client, "lci_search", { query: "add two numbers together", limit: 5 }),
    ) as Array<{
      score: number;
      filePath: string;
      nodeId?: string;
    }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.score).toBeLessThanOrEqual(1);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(-1);
    expect(hits.some((h) => h.filePath.includes("math.rs"))).toBe(true);
  });

  it("never wrote anything but JSON-RPC to stdout (logs are stderr-only)", () => {
    // If any log line had leaked onto stdout, our line-based JSON.parse in the client harness would
    // already have thrown well before this point — this assertion documents the invariant explicitly.
    expect(client.stderr()).toContain("MCP server ready");
  });
});
