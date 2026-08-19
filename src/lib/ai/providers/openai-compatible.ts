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
  /** Extra provider-specific fields merged into the request body, e.g. OpenRouter's `reasoning` cap. */
  extraBody?: Record<string, unknown>;
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

/**
 * Maps our provider-agnostic AiMessage onto the OpenAI-compatible wire
 * format. Only role:"tool" and an assistant message carrying toolCalls need
 * special shaping — everything else passes through as {role, content}.
 */
function toWireMessage(message: AiCompletionRequest["messages"][number]) {
  if (message.role === "tool") {
    return { role: "tool" as const, tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant" as const,
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
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
        messages: request.messages.map(toWireMessage),
        max_tokens: request.maxTokens ?? 200,
        temperature: request.temperature ?? 0.6,
        // Explicit, not just relying on the provider's default — this
        // module only ever reads the body as a single JSON object
        // (see below), so a streamed (SSE) response would already fail
        // to parse. Forcing this off removes streaming as a variable
        // when diagnosing a malformed_response failure.
        stream: false,
        ...(request.tools && request.tools.length > 0 ? { tools: toOpenAiToolSchema(request.tools) } : {}),
        ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
        ...cfg.extraBody,
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
  // Read the body exactly once, as text, regardless of outcome — this is
  // what lets a JSON-parse failure below still report the real status,
  // content-type, requested model, and raw body instead of discarding
  // that evidence the moment response.json() would have thrown. None of
  // this is ever shown to the end user (see USER_SAFE_MESSAGES in
  // hermes-service.ts) — the message text reaches agent_runs.output for
  // diagnosis; the console.error calls below additionally put the same
  // evidence in Vercel's runtime logs.
  const contentType = response.headers.get("content-type") ?? "unknown";
  const rawBody = await safeReadText(response);
  const bodySnippet = rawBody.slice(0, 1000) || "(empty)";
  const diagnostics = `HTTP ${response.status}, content-type: ${contentType}, model requested: ${model}. Raw body (first 1000 chars): ${bodySnippet}`;

  if (!response.ok) {
    throw mapHttpErrorToAiError(cfg.providerName, response.status, rawBody);
  }

  let data: OpenAiCompatibleChatResponse;
  try {
    data = JSON.parse(rawBody) as OpenAiCompatibleChatResponse;
  } catch (cause) {
    console.error(`[ai] ${cfg.providerName} returned a non-JSON response`, {
      status: response.status,
      contentType,
      model,
      bodySnippet,
    });
    throw new AiError({
      code: "malformed_response",
      provider: cfg.providerName,
      message: `${cfg.providerName} returned a non-JSON response. ${diagnostics}`,
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
    console.error(`[ai] ${cfg.providerName} returned an empty completion`, {
      status: response.status,
      contentType,
      model,
      bodySnippet,
    });
    throw new AiError({
      code: "malformed_response",
      provider: cfg.providerName,
      message: `${cfg.providerName} returned an empty completion. ${diagnostics}`,
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
