import crypto from "node:crypto";
import http from "node:http";

// A deterministic stand-in for a real OpenAI-compatible provider, so tests need no external
// dependency. Input order is deliberately scrambled in the response to prove the client re-sorts
// by the response's own `index` field.

export interface FakeEmbeddingServer {
  url: string;
  close: () => Promise<void>;
  stats: { requestCount: number };
}

function deterministicVector(text: string, dimensions: number): number[] {
  const hash = crypto.createHash("sha256").update(text).digest();
  return Array.from({ length: dimensions }, (_, i) => hash[i % hash.length]! / 255);
}

export async function startFakeEmbeddingServer(dimensions = 8): Promise<FakeEmbeddingServer> {
  const stats = { requestCount: 0 };
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/embeddings")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      stats.requestCount++;
      const parsed = JSON.parse(body) as { model: string; input: string[]; encoding_format: string };
      if (parsed.encoding_format !== "float") {
        res.writeHead(400).end(JSON.stringify({ error: "encoding_format must be float" }));
        return;
      }
      const data = parsed.input
        .map((text, index) => ({ index, embedding: deterministicVector(text, dimensions) }))
        .reverse();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("failed to bind fake embedding server");
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    stats,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
