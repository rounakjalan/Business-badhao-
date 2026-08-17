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

/** Error codes worth a small, bounded retry. Auth/config/not-found errors never are. */
const RETRYABLE_CODES: ReadonlySet<AiErrorCode> = new Set(["timeout", "provider_unavailable", "network_error", "rate_limited"]);

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

  constructor(params: { code: AiErrorCode; provider: AiProviderName; message: string; statusCode?: number; cause?: unknown }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "AiError";
    this.code = params.code;
    this.provider = params.provider;
    this.statusCode = params.statusCode;
    this.retryable = RETRYABLE_CODES.has(params.code);
  }
}

/** Thrown for invalid *configuration* (bad env values) — distinct from a runtime provider failure. */
export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}
