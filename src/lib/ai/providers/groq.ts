import { AiError } from "@/lib/ai/errors";
import { callOpenAiCompatibleChat } from "@/lib/ai/providers/openai-compatible";
import type { AiProvider } from "@/lib/ai/providers/provider";
import type { AiCompletionRequest, AiCompletionResponse } from "@/lib/ai/types";

// Groq's OpenAI-compatible API. No default model is hard-coded on purpose —
// Groq's hosted model lineup changes, and picking one here would silently
// go stale. GROQ_MODEL must be set explicitly for this provider to be used.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export class GroqProvider implements AiProvider {
  readonly name = "groq" as const;

  private get apiKey(): string | undefined {
    return process.env.GROQ_API_KEY;
  }

  private get model(): string | undefined {
    return process.env.GROQ_MODEL?.trim() || undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.model);
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const apiKey = this.apiKey;
    const model = this.model;
    if (!apiKey || !model) {
      throw new AiError({
        code: "not_configured",
        provider: this.name,
        message: "GROQ_API_KEY and GROQ_MODEL must both be set",
      });
    }

    return callOpenAiCompatibleChat({ providerName: this.name, baseUrl: GROQ_URL, apiKey, defaultModel: model }, request);
  }
}
