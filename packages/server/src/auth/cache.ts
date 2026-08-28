import type { AuthHelperConfig, HelperHeaders } from "./helper.js";
import { runAuthHelper } from "./helper.js";

// In-memory only — headers are short-lived credentials, not worth a persistent cache. Always
// stores an absolute expiry, never a relative TTL rebased off process-start time.

export class AuthHeaderCache {
  private cached?: HelperHeaders;

  constructor(
    private readonly config: AuthHelperConfig,
    private readonly defaultTtlMs: number,
  ) {}

  async getHeaders(): Promise<Record<string, string>> {
    const now = Date.now();
    if (this.cached && (this.cached.expiresAt === undefined || this.cached.expiresAt > now)) {
      return this.cached.headers;
    }
    return this.refresh();
  }

  async refresh(): Promise<Record<string, string>> {
    const result = await runAuthHelper(this.config);
    this.cached = { headers: result.headers, expiresAt: result.expiresAt ?? Date.now() + this.defaultTtlMs };
    return this.cached.headers;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
