// stdout is reserved for MCP protocol output; every log line goes to stderr, one JSON object per
// line so a host can still parse it structurally if it chooses to.

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVELS: LogLevel[] = ["error", "warn", "info", "debug", "trace"];

export class Logger {
  constructor(private readonly level: LogLevel) {}

  private enabled(level: LogLevel): boolean {
    return LEVELS.indexOf(level) <= LEVELS.indexOf(this.level);
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (!this.enabled(level)) return;
    // Callers are responsible for never passing secrets (headers, API keys, helper stdout) into `meta`.
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...meta })}\n`);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.write("error", msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write("warn", msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.write("info", msg, meta);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.write("debug", msg, meta);
  }

  trace(msg: string, meta?: Record<string, unknown>): void {
    this.write("trace", msg, meta);
  }
}
