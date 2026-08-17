// Provider-agnostic types for the AI layer. Nothing in here may depend on
// a specific provider's SDK or response shape — that normalization happens
// inside each provider implementation (src/lib/ai/providers/*).

export type AiProviderName = "openrouter" | "huggingface" | "groq";

export type AiMessageRole = "system" | "user" | "assistant";

export type AiMessage = {
  role: AiMessageRole;
  content: string;
};

/** JSON-schema-shaped tool/function definition, provider-agnostic. */
export type AiToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AiToolCall = {
  id: string;
  name: string;
  /** Raw JSON string of arguments, as returned by the model. */
  arguments: string;
};

export type AiCompletionRequest = {
  messages: AiMessage[];
  /** Overrides the provider's configured default model for this call. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  tools?: AiToolDefinition[];
};

export type AiUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

/** Normalized response shape — identical regardless of which provider served it. */
export type AiCompletionResponse = {
  text: string | null;
  provider: AiProviderName;
  model: string;
  finishReason: string | null;
  usage: AiUsage;
  toolCalls: AiToolCall[];
  requestId: string | null;
  latencyMs: number;
};
