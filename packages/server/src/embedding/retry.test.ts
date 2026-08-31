import { describe, expect, it } from "vitest";

import { BASE_BACKOFF_MS, backoffDelayMs, isRetryableStatus, MAX_BACKOFF_MS } from "./retry.js";

describe("isRetryableStatus", () => {
  it("retries 429 and any 5xx", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it("does not retry other 4xx (a configuration error, retrying only delays the report)", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and is capped at MAX_BACKOFF_MS", () => {
    const d0 = backoffDelayMs(0);
    const d1 = backoffDelayMs(1);
    const d5 = backoffDelayMs(5);
    expect(d0).toBeGreaterThanOrEqual(BASE_BACKOFF_MS);
    expect(d1).toBeGreaterThan(d0);
    expect(d5).toBeLessThanOrEqual(MAX_BACKOFF_MS + 250); // + max jitter
  });

  it("is deterministic for a given attempt (no RNG)", () => {
    expect(backoffDelayMs(2)).toBe(backoffDelayMs(2));
  });

  it("honors an explicit Retry-After value over the computed backoff", () => {
    expect(backoffDelayMs(0, 12_345)).toBe(12_345);
  });
});
