import { AiError } from "@/lib/ai/errors";
import { callOpenAiCompatibleChat } from "@/lib/ai/providers/openai-compatible";
import type { AiProvider } from "@/lib/ai/providers/provider";
import type { AiCompletionRequest, AiCompletionResponse } from "@/lib/ai/types";

/** Kept as the default so the existing Ask AI behavior doesn't change for anyone who hasn't set OPENROUTER_MODEL. */
export const DEFAULT_OPENROUTER_MODEL = "nousresearch/hermes-4-70b";

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
      },
      request
    );
  }
}
