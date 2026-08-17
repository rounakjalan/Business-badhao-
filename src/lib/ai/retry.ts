import { AiError } from "@/lib/ai/errors";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return 300 * 2 ** attempt;
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
      await sleep(backoffMs(attempt));
    }
  }

  // Unreachable (the loop always throws or returns), but keeps TypeScript
  // happy about every code path returning/throwing.
  throw lastError;
}
