import { AiConfigError } from "@/lib/ai/errors";
import type { AiProviderName } from "@/lib/ai/types";

const VALID_PROVIDERS: readonly AiProviderName[] = ["openrouter", "huggingface", "groq"];

export type AiConfig = {
  provider: AiProviderName;
  /** null means no fallback — a primary-provider failure is reported as-is. */
  fallbackProvider: AiProviderName | null;
  timeoutMs: number;
  maxRetries: number;
};

function parseProviderName(value: string | undefined, envVar: string): AiProviderName | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!VALID_PROVIDERS.includes(trimmed as AiProviderName)) {
    throw new AiConfigError(`${envVar} must be one of ${VALID_PROVIDERS.join(", ")} (got "${trimmed}")`);
  }
  return trimmed as AiProviderName;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Reads and validates the server-side AI configuration from environment
 * variables. Never reads or exposes anything under NEXT_PUBLIC_ — this is
 * intentionally only callable from server code (Server Actions, route
 * handlers), same as the rest of src/lib/ai.
 */
export function getAiConfig(): AiConfig {
  const provider = parseProviderName(process.env.AI_PROVIDER, "AI_PROVIDER") ?? "openrouter";
  const fallbackProvider = parseProviderName(process.env.AI_FALLBACK_PROVIDER, "AI_FALLBACK_PROVIDER");

  if (fallbackProvider && fallbackProvider === provider) {
    throw new AiConfigError("AI_FALLBACK_PROVIDER must be different from AI_PROVIDER");
  }

  return {
    provider,
    fallbackProvider,
    timeoutMs: parsePositiveInt(process.env.AI_TIMEOUT_MS, 20_000),
    maxRetries: parseNonNegativeInt(process.env.AI_MAX_RETRIES, 1),
  };
}
