import { setTimeout as delay } from "node:timers/promises";

import type { Logger } from "../logging.js";
import { backoffDelayMs, isRetryableStatus } from "./retry.js";

// OpenAI-compatible /embeddings client: response reordered by the server's own `index` field, retry
// only connect/timeout/429/5xx, honor Retry-After, never log the request body (it carries repo
// source), always send encoding_format explicitly.

export interface EmbeddingClientOptions {
  baseUrl: string;
  model: string;
  dimensions?: number;
  requestTimeoutMs: number;
  maxRetries: number;
  /** Resolves current outbound headers (static API key and/or auth-helper output already merged). */
  headersProvider: () => Promise<Record<string, string>>;
  /** Called once on a 401/403 before a single bounded retry. */
  onAuthFailure?: () => Promise<void>;
  logger: Logger;
}

interface EmbeddingDatum {
  index: number;
  embedding: number[];
}

export class EmbeddingClient {
  constructor(private readonly opts: EmbeddingClientOptions) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // `authRetried` bounds the 401/403 path to exactly one retry, independent of `retryAttempt` —
    // with `maxRetries: 0` the generic backoff budget is exhausted immediately, but an auth retry
    // must still get its one shot, so the two counters are deliberately not the same one.
    let authRetried = false;
    let retryAttempt = 0;

    for (;;) {
      const headers = await this.opts.headersProvider();
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);

      try {
        const response = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            model: this.opts.model,
            input: texts,
            encoding_format: "float",
            ...(this.opts.dimensions ? { dimensions: this.opts.dimensions } : {}),
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutHandle);

        if ((response.status === 401 || response.status === 403) && !authRetried && this.opts.onAuthFailure) {
          authRetried = true;
          this.opts.logger.warn("embedding auth failure, invalidating cache and retrying once", {
            status: response.status,
          });
          await this.opts.onAuthFailure();
          continue;
        }

        if (!response.ok) {
          const bodyText = (await response.text().catch(() => "")).slice(0, 512);
          const retryable = isRetryableStatus(response.status);
          if (!retryable || retryAttempt >= this.opts.maxRetries) {
            throw new Error(`embedding request failed: HTTP ${response.status} ${bodyText}`);
          }
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterMs =
            retryAfterHeader && !Number.isNaN(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : undefined;
          this.opts.logger.warn("embedding request retrying", { status: response.status, attempt: retryAttempt });
          await delay(backoffDelayMs(retryAttempt, retryAfterMs));
          retryAttempt++;
          continue;
        }

        const parsed = (await response.json()) as { data: EmbeddingDatum[] };
        if (parsed.data.length !== texts.length) {
          throw new Error(`embedding response count mismatch: sent ${texts.length}, got ${parsed.data.length}`);
        }
        const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
        const isPermutation = sorted.every((d, i) => d.index === i);
        if (!isPermutation) {
          throw new Error("embedding response indices are not a valid permutation of the request order");
        }
        return sorted.map((d) => d.embedding);
      } catch (err) {
        clearTimeout(timeoutHandle);
        const isAbort = err instanceof Error && err.name === "AbortError";
        const isConnectError = err instanceof TypeError;
        if ((isAbort || isConnectError) && retryAttempt < this.opts.maxRetries) {
          this.opts.logger.warn("embedding request retrying after connect/timeout error", {
            attempt: retryAttempt,
            error: String(err),
          });
          await delay(backoffDelayMs(retryAttempt));
          retryAttempt++;
          continue;
        }
        throw err;
      }
    }
  }
}
