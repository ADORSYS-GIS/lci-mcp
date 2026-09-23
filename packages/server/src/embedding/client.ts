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
  /** Upper bound on estimated input tokens per HTTP request; larger batches are split to fit.
   * When unset, no token-based splitting is applied. */
  maxInputTokens?: number;
  /** Hard cap on characters for a single input; longer inputs are truncated to fit the model's
   * per-input limit (one chunk cannot be split across requests). When unset, no truncation. */
  maxInputChars?: number;
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
    const prepared = texts.map((text) => this.clampToRequestLimits(text));
    const vectors: number[][] = [];
    for (const group of this.splitByTokenBudget(prepared)) {
      vectors.push(...(await this.embedWithSplitting(group, 0)));
    }
    return vectors;
  }

  // The character estimate cannot predict token-dense content (certificates, base64, CJK), so a
  // request may still exceed the model's context window even after clamping and budgeting. When the
  // upstream rejects it for length, recover using the exact counts it reports: subdivide a batch, or
  // truncate a lone input, then retry. This adapts to real token counts without a tokenizer.
  private async embedWithSplitting(texts: string[], depth: number): Promise<number[][]> {
    try {
      return await this.embedRequest(texts);
    } catch (error) {
      const limit = parseLengthError(error);
      if (limit === undefined || depth >= MAX_SPLIT_DEPTH) throw error;
      if (texts.length > 1) {
        const mid = Math.ceil(texts.length / 2);
        const head = await this.embedWithSplitting(texts.slice(0, mid), depth + 1);
        const tail = await this.embedWithSplitting(texts.slice(mid), depth + 1);
        return [...head, ...tail];
      }
      const shortened = shortenToLimit(texts[0], limit);
      if (shortened.length >= texts[0].length) throw error;
      this.opts.logger.warn("embedding input exceeded the model limit, truncating and retrying", {
        ...limit,
        newLength: shortened.length,
      });
      return this.embedWithSplitting([shortened], depth + 1);
    }
  }

  // A single chunk is one indivisible input, so an over-limit chunk cannot be split across requests
  // — it is truncated (best effort) so one pathological input keeps indexing progressing instead of
  // failing the whole generation. Both bounds are enforced because either can be exceeded on its
  // own: the model's hard per-input character cap (maxInputChars) and the per-request token budget
  // (maxInputTokens), the latter converted to characters with the estimator's ratio so a clamped
  // input never overshoots the token context window even when maxInputChars is left unset.
  private clampToRequestLimits(text: string): string {
    const tokenCharCap =
      this.opts.maxInputTokens === undefined ? undefined : this.opts.maxInputTokens * CHARS_PER_TOKEN;
    const limit = minDefined(this.opts.maxInputChars, tokenCharCap);
    if (limit === undefined || text.length <= limit) return text;
    this.opts.logger.warn("embedding input exceeds per-request limit, truncating", {
      length: text.length,
      limit,
    });
    return text.slice(0, limit);
  }

  // Splits a batch so each request's estimated token total stays within `maxInputTokens`. The
  // upstream context window is a hard per-request limit, so an oversized single chunk is still sent
  // alone (best effort) with a warning rather than silently dropped.
  private splitByTokenBudget(texts: string[]): string[][] {
    const budget = this.opts.maxInputTokens ?? Number.POSITIVE_INFINITY;
    const groups: string[][] = [];
    let current: string[] = [];
    let currentTokens = 0;
    for (const text of texts) {
      const tokens = estimateTokens(text);
      if (tokens > budget) {
        this.opts.logger.warn("embedding input exceeds maxInputTokens, sending it in its own request", {
          estimatedTokens: tokens,
          maxInputTokens: budget,
        });
      }
      if (current.length > 0 && currentTokens + tokens > budget) {
        groups.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(text);
      currentTokens += tokens;
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  private async embedRequest(texts: string[]): Promise<number[][]> {
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

// Assumed characters-per-token for the tokenizer-free estimate. Kept deliberately low (token-dense
// content such as code, JSON, and base64 can fall below ~3.4 chars/token) so token counts are
// over-estimated rather than under, leaving real headroom against the model's hard per-request
// context window. The same ratio bounds a single input's characters in clampToRequestLimits.
const CHARS_PER_TOKEN = 3;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

// Bounds recursion in embedWithSplitting; halving a batch and truncating an input converge well
// within this many steps for any realistic input size.
const MAX_SPLIT_DEPTH = 16;

interface LengthLimit {
  kind: "tokens" | "chars";
  passed: number;
  max: number;
}

// Recognizes the "input too long" rejections from OpenAI-compatible embedding servers and extracts
// the reported counts so a retry can shrink the request precisely. Returns undefined for unrelated
// errors so they propagate unchanged.
function parseLengthError(error: unknown): LengthLimit | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const passedTokens = /passed (\d+) input tokens/.exec(message);
  const maxTokens = /(?:maximum input length of|context length is only) (\d+)/.exec(message);
  if (passedTokens && maxTokens) {
    return { kind: "tokens", passed: Number(passedTokens[1]), max: Number(maxTokens[1]) };
  }
  const chars = /less than (\d+) characters[^]*?Input length: (\d+)/.exec(message);
  if (chars) {
    return { kind: "chars", max: Number(chars[1]), passed: Number(chars[2]) };
  }
  return undefined;
}

// Shrinks a single over-limit input to fit. A character limit truncates directly; a token limit is
// converted to characters via the server-reported ratio with 15% headroom, since one token can span
// several characters and the mapping is not exact.
function shortenToLimit(text: string, limit: LengthLimit): string {
  if (limit.kind === "chars") return text.slice(0, Math.max(1, limit.max - 1));
  const ratio = limit.max / limit.passed;
  const target = Math.max(1, Math.floor(text.length * ratio * 0.85));
  return text.slice(0, Math.min(text.length, target));
}
