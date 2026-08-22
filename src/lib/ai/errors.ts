import type { AiProviderName } from "@/lib/ai/types";

export type AiErrorCode =
  | "not_configured"
  | "invalid_api_key"
  | "rate_limited"
  | "timeout"
  | "provider_unavailable"
  | "model_not_found"
  | "malformed_response"
  | "network_error"
  | "unknown";

/**
 * Error codes worth a small, bounded retry. Auth/config/not-found errors
 * never are. malformed_response is included because it's frequently a
 * transient upstream hiccup on free-tier reasoning models (e.g. the
 * completion coming back empty because the model spent its whole token
 * budget on reasoning) rather than a permanently broken request.
 */
const RETRYABLE_CODES: ReadonlySet<AiErrorCode> = new Set([
  "timeout",
  "provider_unavailable",
  "network_error",
  "rate_limited",
  "malformed_response",
]);

/**
 * The only error type a provider implementation may throw. Carries a
 * normalized code so callers (the Hermes service, Ask AI, future agents)
 * never need to branch on a specific provider's error shape.
 */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly provider: AiProviderName;
  readonly retryable: boolean;
  readonly statusCode?: number;
  /** How long the provider itself asked us to wait, when it said so (see parseRetryAfterMs). */
  readonly retryAfterMs?: number;

  constructor(params: {
    code: AiErrorCode;
    provider: AiProviderName;
    message: string;
    statusCode?: number;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "AiError";
    this.code = params.code;
    this.provider = params.provider;
    this.statusCode = params.statusCode;
    this.retryAfterMs = params.retryAfterMs;
    this.retryable = RETRYABLE_CODES.has(params.code);
  }
}

/**
 * Rate-limit responses state how long to wait ("Please try again in
 * 2.5125s"), and that wait is routinely longer than a short fixed backoff.
 * Honoring the provider's own number turns a give-up into a success; a
 * generic backoff just retries too early and burns the remaining attempts.
 *
 * Returns undefined when no wait is stated, so the caller keeps its default.
 */
export function parseRetryAfterMs(message: string): number | undefined {
  const match = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message);
  if (!match) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  return match[2].toLowerCase() === "ms" ? Math.ceil(value) : Math.ceil(value * 1000);
}

/** Thrown for invalid *configuration* (bad env values) — distinct from a runtime provider failure. */
export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}
