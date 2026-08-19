import { AiError } from "@/lib/ai/errors";
import { callOpenAiCompatibleChat } from "@/lib/ai/providers/openai-compatible";
import type { AiProvider } from "@/lib/ai/providers/provider";
import type { AiCompletionRequest, AiCompletionResponse } from "@/lib/ai/types";

/**
 * Business Badhao's configured primary model — used whenever OPENROUTER_MODEL
 * isn't set. Nemotron 3 Ultra's free endpoint on OpenRouter. Still fully
 * overridable via OPENROUTER_MODEL; nothing in the router or agents hard-codes
 * this identifier.
 */
export const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * OpenRouter adapter. This is the provider Business Badhao currently ships
 * with configured (see .env.example) — Hugging Face and Groq are optional
 * alternates behind the same interface.
 */
export class OpenRouterProvider implements AiProvider {
  readonly name = "openrouter" as const;

  private get apiKey(): string | undefined {
    return process.env.OPENROUTER_API_KEY;
  }

  private get model(): string {
    return process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new AiError({ code: "not_configured", provider: this.name, message: "OPENROUTER_API_KEY is not set" });
    }

    return callOpenAiCompatibleChat(
      {
        providerName: this.name,
        baseUrl: OPENROUTER_URL,
        apiKey,
        defaultModel: this.model,
        extraHeaders: { "X-Title": "Business Badhao" },
        // Caps reasoning-token spend on reasoning models (e.g. the default
        // Nemotron 3 Ultra) to a fraction of maxTokens instead of letting
        // reasoning consume the entire budget and leave nothing for the
        // actual content — which is what was producing empty completions
        // (malformed_response). See OpenRouter's unified reasoning API.
        extraBody: { reasoning: { effort: "low" } },
      },
      request
    );
  }
}
