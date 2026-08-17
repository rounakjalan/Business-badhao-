import type { AiCompletionRequest, AiCompletionResponse, AiProviderName } from "@/lib/ai/types";

/**
 * The contract every AI provider adapter implements. Hermes (and any
 * future agent) only ever talks to this interface — never to a provider's
 * SDK or response shape directly — so providers can be added or swapped
 * without touching agent code.
 */
export interface AiProvider {
  readonly name: AiProviderName;

  /** Whether this provider has the credentials it needs to be called. */
  isConfigured(): boolean;

  /** Throws AiError on any failure; never returns a provider-specific shape. */
  complete(request: AiCompletionRequest): Promise<AiCompletionResponse>;
}
