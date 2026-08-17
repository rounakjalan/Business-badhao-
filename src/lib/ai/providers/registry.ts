import { GroqProvider } from "@/lib/ai/providers/groq";
import { HuggingFaceProvider } from "@/lib/ai/providers/huggingface";
import { OpenRouterProvider } from "@/lib/ai/providers/openrouter";
import type { AiProvider } from "@/lib/ai/providers/provider";
import type { AiProviderName } from "@/lib/ai/types";

/**
 * Centralized provider construction. This is the only place in the app
 * that maps a provider name to a concrete adapter — adding a new provider
 * means adding one case here (plus its own adapter file), nothing else.
 */
export function createProvider(name: AiProviderName): AiProvider {
  switch (name) {
    case "openrouter":
      return new OpenRouterProvider();
    case "huggingface":
      return new HuggingFaceProvider();
    case "groq":
      return new GroqProvider();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown AI provider: ${String(exhaustive)}`);
    }
  }
}
