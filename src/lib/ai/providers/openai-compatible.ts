import { AiError } from "@/lib/ai/errors";
import type { AiCompletionRequest, AiCompletionResponse, AiProviderName, AiToolDefinition } from "@/lib/ai/types";

// OpenRouter, Hugging Face's Inference Providers router, and Groq all speak
// the same OpenAI-compatible chat-completions wire format. This module is
// the single place that talks HTTP and parses that format, so none of the
// three provider adapters duplicate request-building or error-mapping logic.

export type OpenAiCompatibleConfig = {
  providerName: AiProviderName;
  /** Full chat-completions URL, e.g. https://openrouter.ai/api/v1/chat/completions */
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
};

type OpenAiCompatibleToolCall = {
  id: string;
  function?: { name?: string; arguments?: string };
};

type OpenAiCompatibleChatResponse = {
  id?: string;
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAiCompatibleToolCall[] };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

function toOpenAiToolSchema(tools: AiToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function mapHttpErrorToAiError(provider: AiProviderName, status: number, bodyText: string): AiError {
  const snippet = bodyText.slice(0, 300);
  if (status === 401 || status === 403) {
    return new AiError({ code: "invalid_api_key", provider, message: `${provider} rejected the configured API key`, statusCode: status });
  }
  if (status === 404) {
    return new AiError({ code: "model_not_found", provider, message: `${provider} could not find the requested model`, statusCode: status });
  }
  if (status === 429) {
    return new AiError({ code: "rate_limited", provider, message: `${provider} rate limit exceeded`, statusCode: status });
  }
  if (status >= 500) {
    return new AiError({ code: "provider_unavailable", provider, message: `${provider} server error (HTTP ${status})`, statusCode: status });
  }
  return new AiError({ code: "unknown", provider, message: `${provider} returned HTTP ${status}: ${snippet}`, statusCode: status });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export async function callOpenAiCompatibleChat(
  cfg: OpenAiCompatibleConfig,
  request: AiCompletionRequest
): Promise<AiCompletionResponse> {
  const model = request.model ?? cfg.defaultModel;
  const timeoutMs = request.timeoutMs ?? 20_000;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(cfg.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        ...cfg.extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? 200,
        temperature: request.temperature ?? 0.6,
        ...(request.tools && request.tools.length > 0 ? { tools: toOpenAiToolSchema(request.tools) } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const isTimeout = cause instanceof Error && cause.name === "TimeoutError";
    throw new AiError({
      code: isTimeout ? "timeout" : "network_error",
      provider: cfg.providerName,
      message: isTimeout
        ? `${cfg.providerName} request timed out after ${timeoutMs}ms`
        : `${cfg.providerName} could not be reached`,
      cause,
    });
  }

  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    throw mapHttpErrorToAiError(cfg.providerName, response.status, await safeReadText(response));
  }

  let data: OpenAiCompatibleChatResponse;
  try {
    data = (await response.json()) as OpenAiCompatibleChatResponse;
  } catch (cause) {
    throw new AiError({
      code: "malformed_response",
      provider: cfg.providerName,
      message: `${cfg.providerName} returned a response that could not be parsed as JSON`,
      cause,
    });
  }

  const choice = data.choices?.[0];
  const text = choice?.message?.content?.trim() || null;
  const toolCalls = (choice?.message?.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function?.name ?? "",
    arguments: call.function?.arguments ?? "{}",
  }));

  if (!text && toolCalls.length === 0) {
    throw new AiError({
      code: "malformed_response",
      provider: cfg.providerName,
      message: `${cfg.providerName} returned an empty completion`,
    });
  }

  return {
    text,
    provider: cfg.providerName,
    model: data.model ?? model,
    finishReason: choice?.finish_reason ?? null,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      totalTokens: data.usage?.total_tokens ?? null,
    },
    toolCalls,
    requestId: data.id ?? null,
    latencyMs,
  };
}
