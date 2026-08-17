import { getAiConfig } from "@/lib/ai/config";
import { AiError, type AiErrorCode } from "@/lib/ai/errors";
import { createProvider } from "@/lib/ai/providers/registry";
import { withRetry } from "@/lib/ai/retry";
import { completeAgentRun, createAgentRun } from "@/lib/ai/tracking/agent-runs";
import { recordModelUsage } from "@/lib/ai/tracking/model-usage";
import type { AiCompletionRequest, AiMessage, AiProviderName } from "@/lib/ai/types";

export type HermesRequest = {
  /** null for actions that can happen before onboarding (e.g. an unauthenticated preview) — tracking is skipped in that case. */
  organizationId: string | null;
  /** Free-form label for agent_runs.agent_type, e.g. "ask_ai_sidekick". */
  agentType: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Set to "json" for agents that parse the result with src/lib/ai/schema.ts. */
  responseFormat?: "text" | "json";
};

export type HermesSuccess = {
  ok: true;
  text: string;
  provider: AiProviderName;
  model: string;
};

export type HermesFailure = {
  ok: false;
  code: AiErrorCode;
  /** Safe to show to an end user — never a raw provider error or secret. */
  message: string;
};

export type HermesResult = HermesSuccess | HermesFailure;

const USER_SAFE_MESSAGES: Record<AiErrorCode, string> = {
  not_configured: "The AI assistant isn't connected yet.",
  invalid_api_key: "The AI provider rejected the configured credentials.",
  rate_limited: "The AI provider is rate-limiting requests right now — try again shortly.",
  timeout: "The AI provider took too long to respond. Try again.",
  provider_unavailable: "The AI provider is temporarily unavailable.",
  model_not_found: "The configured AI model is unavailable.",
  malformed_response: "The AI provider returned an unexpected response.",
  network_error: "Couldn't reach the AI provider. Try again in a moment.",
  unknown: "Something went wrong talking to the AI provider.",
};

/**
 * The single entry point every AI feature in Business Badhao calls through
 * — never a provider directly. Handles provider selection (with an
 * explicit, opt-in fallback), retries for transient errors, and best-effort
 * agent_runs/model_usage tracking.
 *
 * UI / Server Action -> runHermesCompletion -> provider abstraction -> model
 */
export async function runHermesCompletion(request: HermesRequest): Promise<HermesResult> {
  const config = getAiConfig();
  const providerOrder: AiProviderName[] = config.fallbackProvider
    ? [config.provider, config.fallbackProvider]
    : [config.provider];

  const messages: AiMessage[] = [
    { role: "system", content: request.systemPrompt },
    { role: "user", content: request.userPrompt },
  ];

  const agentRun = await createAgentRun(request.organizationId, request.agentType, {
    primaryProvider: config.provider,
    fallbackProvider: config.fallbackProvider,
  });

  let lastError: AiError | null = null;

  for (const providerName of providerOrder) {
    const provider = createProvider(providerName);

    if (!provider.isConfigured()) {
      lastError = new AiError({ code: "not_configured", provider: providerName, message: `${providerName} is not configured` });
      continue;
    }

    try {
      const completionRequest: AiCompletionRequest = {
        messages,
        maxTokens: request.maxTokens ?? 200,
        temperature: request.temperature ?? 0.6,
        timeoutMs: config.timeoutMs,
        responseFormat: request.responseFormat,
      };

      const response = await withRetry(() => provider.complete(completionRequest), config.maxRetries);

      await recordModelUsage({
        organizationId: request.organizationId,
        agentRunId: agentRun?.id ?? null,
        provider: response.provider,
        model: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });

      if (!response.text) {
        await completeAgentRun(agentRun, "failed", { code: "malformed_response" });
        return { ok: false, code: "malformed_response", message: USER_SAFE_MESSAGES.malformed_response };
      }

      await completeAgentRun(agentRun, "completed", {
        provider: response.provider,
        model: response.model,
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
      });

      return { ok: true, text: response.text, provider: response.provider, model: response.model };
    } catch (error) {
      lastError =
        error instanceof AiError
          ? error
          : new AiError({ code: "unknown", provider: providerName, message: "Unexpected error calling the AI provider", cause: error });
      // Move on to the next configured provider in providerOrder, if any.
      // withRetry() already exhausted in-provider retries for transient
      // errors, so we never retry the same provider again here.
    }
  }

  const code = lastError?.code ?? "unknown";
  await completeAgentRun(agentRun, "failed", { code, message: lastError?.message ?? "no provider produced a result" });

  return { ok: false, code, message: USER_SAFE_MESSAGES[code] };
}
