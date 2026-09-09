import type { AiProviderName } from "@/lib/ai/types";

/**
 * Coordinates rate-limit backoff *across* concurrent calls to the same
 * provider — not just within a single call's own retry loop (see
 * src/lib/ai/retry.ts for that). The lead worker pool researches/qualifies
 * several leads at once (see lead-worker-pool.ts), each making its own,
 * otherwise-unaware runHermesCompletion call; when one of them gets a 429
 * from, say, Groq, the others are very likely about to get the exact same
 * 429 a moment later if they fire immediately. Recording that here lets a
 * sibling call about to hit the same provider wait the cooldown out instead
 * of firing straight into it and adding to the problem.
 *
 * Deliberately in-memory and per-process/per-invocation: this only needs to
 * reduce hammering from calls genuinely concurrent within the same
 * serverless invocation. It does not, and is not meant to, coordinate
 * across separate requests or instances — there is no database or network
 * call here, on purpose.
 */

const cooldownUntilMs = new Map<AiProviderName, number>();

/**
 * Upper bound on how long a caller actually waits here before trying
 * anyway. A provider's own stated retry-after can be long; waiting the
 * *full* amount on behalf of a call that hasn't even tried yet would risk
 * the caller's own time budget for a wait that might not even be necessary
 * anymore. Bounded short on purpose — worth a brief pause, never a stall.
 */
const MAX_COOLDOWN_WAIT_MS = 3000;
/** Used when a rate-limited failure didn't carry a provider-stated wait. */
const DEFAULT_COOLDOWN_MS = 1500;

/** Call when a provider call has just failed with AiErrorCode "rate_limited". */
export function recordProviderRateLimit(provider: AiProviderName, retryAfterMs?: number): void {
  const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_COOLDOWN_MS;
  const until = Date.now() + Math.min(wait, MAX_COOLDOWN_WAIT_MS);
  const existing = cooldownUntilMs.get(provider) ?? 0;
  // Only ever extends an existing cooldown, never shortens one a more
  // specific (or more recent) failure already set.
  if (until > existing) cooldownUntilMs.set(provider, until);
}

/** How long (ms, >= 0) a caller about to hit this provider should wait first. 0 means no known active cooldown. */
export function getProviderCooldownMs(provider: AiProviderName): number {
  const until = cooldownUntilMs.get(provider);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

/** Test-only: clears all recorded cooldowns so one test's rate-limit scenario never leaks into the next. */
export function resetRateLimitGuard(): void {
  cooldownUntilMs.clear();
}
