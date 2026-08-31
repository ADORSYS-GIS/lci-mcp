import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

// A minimal hand-rolled JSON-RPC-over-stdio client: speaks the real wire protocol against the
// actual built CLI as a child process, not a mocked transport.

export interface McpTestClient {
  request: (method: string, params?: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
  stderr: () => string;
  close: () => Promise<void>;
}

export function spawnCli(cliArgs: string[], cwd: string): McpTestClient {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...cliArgs], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message: { id?: number; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  function request(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`);
    });
  }

  function notify(method: string, params?: unknown): void {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })}\n`);
  }

  async function close(): Promise<void> {
    child.stdin.end();
    child.kill();
  }

  return { request, notify, stderr: () => stderrBuffer, close };
}
