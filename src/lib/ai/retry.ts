import { AiError } from "@/lib/ai/errors";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASE_BACKOFF_MS = 300;
/**
 * Ceiling on the exponential growth itself, before jitter — without this, a
 * caller configured with a larger maxRetries could end up waiting many
 * seconds between attempts, eating into a serverless invocation's own time
 * budget for no real benefit (a provider either recovers quickly or it
 * doesn't; waiting longer than a few seconds just delays giving up).
 */
const MAX_BACKOFF_MS = 4000;

/**
 * Full jitter in [50%, 100%] of the capped exponential value. Plain
 * exponential backoff makes every caller that failed at the same moment
 * (e.g. several concurrently-researched leads all hitting the same
 * rate-limited provider) wake up and retry at the same moment too, which
 * just reproduces the same contention a beat later. Jitter spreads those
 * retries out instead of having them collide again.
 */
function backoffMs(attempt: number): number {
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
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
