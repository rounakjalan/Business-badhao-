import { AiError } from "@/lib/ai/errors";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return 300 * 2 ** attempt;
}

/**
 * Upper bound on honoring a provider-stated wait. Rate limits clear in a
 * few seconds; anything longer is not worth holding a request open for,
 * so we fall back to the normal backoff and let the next provider try.
 */
const MAX_RETRY_AFTER_MS = 6000;

function waitMs(err: unknown, attempt: number): number {
  const requested = err instanceof AiError ? err.retryAfterMs : undefined;
  if (requested !== undefined && requested <= MAX_RETRY_AFTER_MS) {
    // The provider told us exactly when its window clears. Retrying before
    // then just spends an attempt on a guaranteed failure.
    return Math.max(requested, backoffMs(attempt));
  }
  return backoffMs(attempt);
}

/**
 * Retries `fn` only for transient failures (AiError.retryable), with a
 * small exponential backoff. Auth failures, bad requests, and
 * model-not-found errors are never retried — retrying those just repeats
 * the same failure and risks duplicate AI calls for no benefit.
 *
 * maxRetries is the number of *extra* attempts beyond the first — 0 means
 * "try once, don't retry."
 */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof AiError && err.retryable;
      if (!retryable || attempt === maxRetries) {
        throw err;
      }
      await sleep(waitMs(err, attempt));
    }
  }

  // Unreachable (the loop always throws or returns), but keeps TypeScript
  // happy about every code path returning/throwing.
  throw lastError;
}
