import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { repositoryEnvelope, resolveToolWorker } from "../context.js";
import { textResult } from "../toolResult.js";

const MAX_LINES = 3000;
const MAX_OUTPUT_BYTES = 96_000;
const MAX_FILE_BYTES = 8_000_000;

/** `lci_read_source` tool registration: reads a bounded line range from a file within a repository. */
export function registerReadSourceTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "lci_read_source",
    {
      description:
        "Reads a bounded line range from a source file in a selected repository, for inspecting the code behind a symbol or search hit. The path must stay within the repository; the response is capped in lines and bytes.",
      inputSchema: {
        repository_id: z.string().optional(),
        path: z.string(),
        start_line: z.number().int().min(1),
        end_line: z.number().int().min(1).optional(),
      },
    },
    async ({ repository_id, path: requestedPath, start_line, end_line }) => {
      const { worker, explicit } = await resolveToolWorker(ctx, repository_id);
      const resolved = await resolveWithinRoot(worker.repositoryRoot, requestedPath);
      if (!resolved) {
        return { content: [{ type: "text", text: "lci_read_source: path is outside the repository or does not exist." }], isError: true };
      }
      const snippet = await readLineRange(resolved, start_line, end_line ?? start_line + MAX_LINES - 1);
      if (!snippet) {
        return { content: [{ type: "text", text: "lci_read_source: file is too large to read." }], isError: true };
      }
      const result = {
        path: toPosix(path.relative(path.resolve(worker.repositoryRoot), resolved)),
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        content: snippet.content,
      };
      return textResult(explicit ? repositoryEnvelope(worker, result) : result);
    },
  );
}

// Resolves `requested` against `root`, rejecting absolute paths, traversal, and symlinks that escape
// the real root; returns the canonical target path or undefined when unsafe or missing.
export async function resolveWithinRoot(root: string, requested: string): Promise<string | undefined> {
  if (path.isAbsolute(requested) || requested.includes("\0")) return undefined;
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, requested);
  const relative = path.relative(rootResolved, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  try {
    const realRoot = await realpath(rootResolved);
    const realTarget = await realpath(target);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return undefined;
    return realTarget;
  } catch {
    return undefined;
  }
}

// Reads inclusive 1-based lines [startLine, endLine], clamped to the file and to MAX_LINES /
// MAX_OUTPUT_BYTES; returns undefined for non-files or files above MAX_FILE_BYTES.
export async function readLineRange(
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<{ startLine: number; endLine: number; content: string } | undefined> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
  const lines = (await readFile(filePath, "utf8")).split("\n");
  const start = Math.min(Math.max(1, Math.trunc(startLine)), Math.max(1, lines.length));
  const end = Math.min(lines.length, Math.max(start, Math.trunc(endLine)), start + MAX_LINES - 1);
  let content = lines.slice(start - 1, end).join("\n");
  if (Buffer.byteLength(content, "utf8") > MAX_OUTPUT_BYTES) content = content.slice(0, MAX_OUTPUT_BYTES);
  return { startLine: start, endLine: end, content };
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
