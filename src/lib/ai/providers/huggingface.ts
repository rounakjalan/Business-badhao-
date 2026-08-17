import { AiError } from "@/lib/ai/errors";
import { callOpenAiCompatibleChat } from "@/lib/ai/providers/openai-compatible";
import type { AiProvider } from "@/lib/ai/providers/provider";
import type { AiCompletionRequest, AiCompletionResponse } from "@/lib/ai/types";

// Hugging Face's OpenAI-compatible "Inference Providers" router. Requires
// both an API token and an explicit model — there is no free-tier default
// baked in here, since HF inference is not unconditionally free and which
// models are hosted (and by whom) changes over time.
const HUGGINGFACE_URL = "https://router.huggingface.co/v1/chat/completions";

export class HuggingFaceProvider implements AiProvider {
  readonly name = "huggingface" as const;

  private get apiKey(): string | undefined {
    return process.env.HUGGINGFACE_API_KEY;
  }

  private get model(): string | undefined {
    return process.env.HUGGINGFACE_MODEL?.trim() || undefined;
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
        message: "HUGGINGFACE_API_KEY and HUGGINGFACE_MODEL must both be set",
      });
    }

    return callOpenAiCompatibleChat(
      { providerName: this.name, baseUrl: HUGGINGFACE_URL, apiKey, defaultModel: model },
      request
    );
  }
}
