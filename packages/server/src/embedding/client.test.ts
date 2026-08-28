import { afterEach, describe, expect, it, vi } from "vitest";

import { Logger } from "../logging.js";
import { EmbeddingClient } from "./client.js";

function silentLogger(): Logger {
  return new Logger("error");
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EmbeddingClient", () => {
  it("short-circuits on empty input without making a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = new EmbeddingClient({
      baseUrl: "http://x",
      model: "m",
      requestTimeoutMs: 1000,
      maxRetries: 0,
      headersProvider: async () => ({}),
      logger: silentLogger(),
    });
    const result = await client.embed([]);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-sorts the response by its own index field, never trusting array position", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: [
            { index: 1, embedding: [9, 9] },
            { index: 0, embedding: [1, 1] },
          ],
        }),
      ),
    );
    const client = new EmbeddingClient({
      baseUrl: "http://x",
      model: "m",
      requestTimeoutMs: 1000,
      maxRetries: 0,
      headersProvider: async () => ({}),
      logger: silentLogger(),
    });
    const result = await client.embed(["a", "b"]);
    expect(result).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it("rejects a response whose count does not match the request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ index: 0, embedding: [1] }] })));
    const client = new EmbeddingClient({
      baseUrl: "http://x",
      model: "m",
      requestTimeoutMs: 1000,
      maxRetries: 0,
      headersProvider: async () => ({}),
      logger: silentLogger(),
    });
    await expect(client.embed(["a", "b"])).rejects.toThrow(/count mismatch/);
  });

  it("rejects a response whose indices are not a valid permutation (a gateway echoing a constant index)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: [
            { index: 0, embedding: [1] },
            { index: 0, embedding: [2] },
          ],
        }),
      ),
    );
    const client = new EmbeddingClient({
      baseUrl: "http://x",
      model: "m",
      requestTimeoutMs: 1000,
      maxRetries: 0,
      headersProvider: async () => ({}),
      logger: silentLogger(),
    });
    await expect(client.embed(["a", "b"])).rejects.toThrow(/permutation/);
  });

  it("retries a 500 and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EmbeddingClient({
      baseUrl: "http://x",
      model: "m",
      requestTimeoutMs: 1000,
      maxRetries: 2,
      headersProvider: async () => ({}),
      logger: silentLogger(),
    });
    const result = await client.embed(["a"]);
    expect(result).toEqual([[1]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a plain 400 (a configuration error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EmbeddingClient({
      baseUrl: "http://x",
      model: "m",
      requestTimeoutMs: 1000,
      maxRetries: 3,
      headersProvider: async () => ({}),
      logger: silentLogger(),
    });
    await expect(client.embed(["a"])).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("on 401, invalidates via onAuthFailure and retries exactly once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const onAuthFailure = vi.fn().mockResolvedValue(undefined);
    const client = new EmbeddingClient({
      baseUrl: "http://x",
      model: "m",
      requestTimeoutMs: 1000,
      maxRetries: 0,
      headersProvider: async () => ({ authorization: "Bearer stale" }),
      onAuthFailure,
      logger: silentLogger(),
    });
    const result = await client.embed(["a"]);
    expect(result).toEqual([[1]]);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("never includes the request body in a thrown error message (it carries repo source)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "SECRET_SOURCE_MARKER" })));
    const client = new EmbeddingClient({
      baseUrl: "http://x",
      model: "m",
      requestTimeoutMs: 1000,
      maxRetries: 0,
      headersProvider: async () => ({}),
      logger: silentLogger(),
    });
    try {
      await client.embed(["fn totally_secret_function_body() {}"]);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("SECRET_SOURCE_MARKER"); // response body is fine to surface
      expect(message).not.toContain("totally_secret_function_body"); // request body must never appear
    }
  });

  it("sends encoding_format explicitly as float", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EmbeddingClient({
      baseUrl: "http://x",
      model: "m",
      requestTimeoutMs: 1000,
      maxRetries: 0,
      headersProvider: async () => ({}),
      logger: silentLogger(),
    });
    await client.embed(["a"]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.encoding_format).toBe("float");
  });
});
