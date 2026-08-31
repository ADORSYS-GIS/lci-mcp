import { spawn } from "node:child_process";

// Executes a configured process without implicit shell expansion and captures/bounds its stdout.
// That stdout carries credentials, so it's never passed to a Logger — only to JSON.parse.

export interface AuthHelperConfig {
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface HelperHeaders {
  headers: Record<string, string>;
  /** Absolute epoch-ms expiry, when the helper provided one. */
  expiresAt?: number;
}

const MAX_STDOUT_BYTES = 64 * 1024;

export function runAuthHelper(config: AuthHelperConfig): Promise<HelperHeaders> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, config.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`auth helper "${config.command}" timed out after ${config.timeoutMs}ms`));
      });
    }, config.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
        finish(() => {
          child.kill("SIGKILL");
          reject(new Error(`auth helper stdout exceeded ${MAX_STDOUT_BYTES} bytes`));
        });
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // Diagnostics only, bounded — never treated as credentials.
      stderr = (stderr + chunk.toString("utf8")).slice(0, 4096);
    });

    child.on("error", (err) => {
      finish(() => reject(new Error(`failed to spawn auth helper "${config.command}": ${err.message}`)));
    });

    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`auth helper "${config.command}" exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout.toString("utf8"));
        } catch {
          reject(new Error("auth helper stdout is not valid JSON"));
          return;
        }
        const result = normalizeHelperOutput(parsed);
        if (!result) {
          reject(new Error("auth helper stdout did not match the expected {headers:{...}} or bare-header-map shape"));
          return;
        }
        resolve(result);
      });
    });
  });
}

function allStringValues(obj: Record<string, unknown>): boolean {
  return Object.values(obj).every((v) => typeof v === "string");
}

function normalizeHelperOutput(value: unknown): HelperHeaders | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  if ("headers" in obj) {
    const headers = obj.headers;
    if (typeof headers !== "object" || headers === null || !allStringValues(headers as Record<string, unknown>)) {
      return undefined;
    }
    const expiresAtRaw = obj.expiresAt;
    const expiresAt = typeof expiresAtRaw === "string" ? Date.parse(expiresAtRaw) : undefined;
    return {
      headers: headers as Record<string, string>,
      expiresAt: expiresAt !== undefined && Number.isFinite(expiresAt) ? expiresAt : undefined,
    };
  }

  if (allStringValues(obj)) {
    return { headers: obj as Record<string, string> };
  }
  return undefined;
}
