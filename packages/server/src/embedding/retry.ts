// Deterministic jitter (no RNG) so retry tests are reproducible.

export const BASE_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 8_000;
export const DEFAULT_MAX_RETRIES = 3;

export function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = (attempt * 2_654_435_761) % 250;
  return exponential + jitter;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
