import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import type { AiProvider } from "@/lib/ai/providers/provider";
import type { AiCompletionResponse } from "@/lib/ai/types";

// The Hermes service is tested in isolation from real providers and real
// Supabase — both are mocked so this suite never makes a network call or
// needs a request context (cookies()) to run.
vi.mock("@/lib/ai/providers/registry", () => ({
  createProvider: vi.fn(),
}));

vi.mock("@/lib/ai/tools/registry", () => ({
  HERMES_TOOL_DEFINITIONS: [{ name: "lookup_lead", description: "test tool", parameters: {} }],
  executeTool: vi.fn(),
}));

// Hoisted so the mock factory below (which vi.mock hoists above imports)
// can reference the same spies the tests inspect afterward.
const { insertSpy, updateSpy } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  updateSpy: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      insert: (payload: unknown) => {
        insertSpy(payload);
        return {
          select: () => ({
            single: async () => ({ data: { id: "run-1" }, error: null }),
          }),
        };
      },
      update: (payload: unknown) => {
        updateSpy(payload);
        return {
          eq: async () => ({ error: null }),
        };
      },
    }),
  })),
}));

import { createProvider } from "@/lib/ai/providers/registry";
import { getProviderCooldownMs, recordProviderRateLimit, resetRateLimitGuard } from "@/lib/ai/rate-limit-guard";
import { executeTool } from "@/lib/ai/tools/registry";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";

const ENV_KEYS = ["AI_PROVIDER", "AI_FALLBACK_PROVIDER", "AI_TIMEOUT_MS", "AI_MAX_RETRIES"] as const;

function fakeResponse(overrides: Partial<AiCompletionResponse> = {}): AiCompletionResponse {
  return {
    text: "a real suggestion",
    provider: "openrouter",
    model: "nousresearch/hermes-4-70b",
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    toolCalls: [],
    requestId: "req-1",
    latencyMs: 42,
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    name: "openrouter",
    isConfigured: () => true,
    complete: vi.fn().mockResolvedValue(fakeResponse()),
    ...overrides,
  };
}

const baseRequest = {
  organizationId: "org-1",
  agentType: "ask_ai_sidekick",
  taskType: "GENERAL_CHAT" as const,
  systemPrompt: "system",
  userPrompt: "user",
};

describe("runHermesCompletion", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    // Every test gets a clean slate — a rate limit recorded by one test must
    // never make an unrelated, later test wait on a cooldown it knows
    // nothing about.
    resetRateLimitGuard();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    vi.clearAllMocks();
    resetRateLimitGuard();
  });

  it("returns a normalized success result from the configured primary provider", async () => {
    vi.mocked(createProvider).mockReturnValue(fakeProvider());

    const result = await runHermesCompletion(baseRequest);

    expect(result).toEqual({
      ok: true,
      text: "a real suggestion",
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });
    expect(createProvider).toHaveBeenCalledWith("openrouter");
  });

  it("passes an explicit model override straight through to the provider, distinct from its configured default", async () => {
    const completeSpy = vi.fn().mockResolvedValue(fakeResponse({ model: "nousresearch/hermes-4-70b" }));
    vi.mocked(createProvider).mockReturnValue(fakeProvider({ complete: completeSpy }));

    await runHermesCompletion({ ...baseRequest, model: "nousresearch/hermes-4-70b" });

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy.mock.calls[0][0].model).toBe("nousresearch/hermes-4-70b");
  });

  it("leaves the provider's own default model in place when no override is given", async () => {
    const completeSpy = vi.fn().mockResolvedValue(fakeResponse());
    vi.mocked(createProvider).mockReturnValue(fakeProvider({ complete: completeSpy }));

    await runHermesCompletion(baseRequest);

    expect(completeSpy.mock.calls[0][0].model).toBeUndefined();
  });

  it("returns a user-safe failure message without a fallback configured", async () => {
    const provider = fakeProvider({
      complete: vi.fn().mockRejectedValue(new AiError({ code: "invalid_api_key", provider: "openrouter", message: "bad key" })),
    });
    vi.mocked(createProvider).mockReturnValue(provider);

    const result = await runHermesCompletion(baseRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_api_key");
      expect(result.message).not.toContain("bad key"); // never leak the raw provider message
    }
    expect(createProvider).toHaveBeenCalledTimes(1);
  });

  it("falls back to the configured fallback provider when the primary fails", async () => {
    process.env.AI_FALLBACK_PROVIDER = "groq";

    const failingPrimary = fakeProvider({
      name: "openrouter",
      complete: vi.fn().mockRejectedValue(new AiError({ code: "provider_unavailable", provider: "openrouter", message: "down" })),
    });
    const workingFallback = fakeProvider({
      name: "groq",
      complete: vi.fn().mockResolvedValue(fakeResponse({ provider: "groq", model: "llama-3.3-70b-versatile" })),
    });

    vi.mocked(createProvider).mockImplementation((name) => (name === "openrouter" ? failingPrimary : workingFallback));

    const result = await runHermesCompletion(baseRequest);

    expect(result).toEqual({ ok: true, text: "a real suggestion", provider: "groq", model: "llama-3.3-70b-versatile" });
    expect(createProvider).toHaveBeenNthCalledWith(1, "openrouter");
    expect(createProvider).toHaveBeenNthCalledWith(2, "groq");
  });

  it("honestly records usedFallback:true and the real serving provider/model when the fallback actually answered — never mislabels a fallback response as the preferred provider", async () => {
    process.env.AI_FALLBACK_PROVIDER = "groq";

    const failingPrimary = fakeProvider({
      name: "openrouter",
      complete: vi.fn().mockRejectedValue(new AiError({ code: "provider_unavailable", provider: "openrouter", message: "down" })),
    });
    const workingFallback = fakeProvider({
      name: "groq",
      complete: vi.fn().mockResolvedValue(fakeResponse({ provider: "groq", model: "llama-3.3-70b-versatile" })),
    });
    vi.mocked(createProvider).mockImplementation((name) => (name === "openrouter" ? failingPrimary : workingFallback));

    await runHermesCompletion(baseRequest);

    const completionUpdate = updateSpy.mock.calls.find(([payload]) => (payload as { status?: string }).status === "completed");
    expect(completionUpdate?.[0]).toMatchObject({
      output: expect.objectContaining({ provider: "groq", model: "llama-3.3-70b-versatile", usedFallback: true }),
    });
  });

  it("never calls the fallback provider unless AI_FALLBACK_PROVIDER is explicitly set", async () => {
    const provider = fakeProvider({
      complete: vi.fn().mockRejectedValue(new AiError({ code: "provider_unavailable", provider: "openrouter", message: "down" })),
    });
    vi.mocked(createProvider).mockReturnValue(provider);

    await runHermesCompletion(baseRequest);

    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith("openrouter");
  });

  it("retries a malformed_response failure from the provider before giving up", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new AiError({ code: "malformed_response", provider: "openrouter", message: "empty completion" }))
      .mockResolvedValueOnce(fakeResponse());
    vi.mocked(createProvider).mockReturnValue(fakeProvider({ complete }));

    const result = await runHermesCompletion(baseRequest);

    expect(result).toEqual({ ok: true, text: "a real suggestion", provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(createProvider).toHaveBeenCalledTimes(1); // retried the same provider, not a fallback
  });

  it("treats an unconfigured provider as not_configured without calling complete()", async () => {
    const provider = fakeProvider({ isConfigured: () => false, complete: vi.fn() });
    vi.mocked(createProvider).mockReturnValue(provider);

    const result = await runHermesCompletion(baseRequest);

    expect(result).toEqual({ ok: false, code: "not_configured", message: expect.any(String) });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("routes an intent-detection task to Groq first when Groq is configured", async () => {
    const groqProvider = fakeProvider({ name: "groq", complete: vi.fn().mockResolvedValue(fakeResponse({ provider: "groq", model: "fast-model" })) });
    const openRouterProvider = fakeProvider({ complete: vi.fn() });
    vi.mocked(createProvider).mockImplementation((name) => (name === "groq" ? groqProvider : openRouterProvider));

    const result = await runHermesCompletion({ ...baseRequest, taskType: "INTENT_DETECTION" });

    expect(result).toEqual({ ok: true, text: "a real suggestion", provider: "groq", model: "fast-model" });
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith("groq");
    expect(openRouterProvider.complete).not.toHaveBeenCalled();
  });

  it("gracefully degrades an intent-detection task to the configured primary when Groq isn't configured (no regression)", async () => {
    const groqProvider = fakeProvider({ name: "groq", isConfigured: () => false, complete: vi.fn() });
    const openRouterProvider = fakeProvider({ complete: vi.fn().mockResolvedValue(fakeResponse()) });
    vi.mocked(createProvider).mockImplementation((name) => (name === "groq" ? groqProvider : openRouterProvider));

    const result = await runHermesCompletion({ ...baseRequest, taskType: "INTENT_DETECTION" });

    expect(result.ok).toBe(true);
    expect(createProvider).toHaveBeenNthCalledWith(1, "groq");
    expect(createProvider).toHaveBeenNthCalledWith(2, "openrouter");
    expect(groqProvider.complete).not.toHaveBeenCalled();
    expect(openRouterProvider.complete).toHaveBeenCalledTimes(1);
  });

  it("never routes a research task to Groq just because Groq happens to be configured as the fallback", async () => {
    process.env.AI_FALLBACK_PROVIDER = "groq";
    const openRouterProvider = fakeProvider({ complete: vi.fn().mockResolvedValue(fakeResponse()) });
    const groqProvider = fakeProvider({ name: "groq", complete: vi.fn() });
    vi.mocked(createProvider).mockImplementation((name) => (name === "groq" ? groqProvider : openRouterProvider));

    const result = await runHermesCompletion({ ...baseRequest, agentType: "campaign_planner", taskType: "CAMPAIGN_PLANNING" });

    expect(result.ok).toBe(true);
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith("openrouter");
    expect(groqProvider.complete).not.toHaveBeenCalled();
  });

  it("modelProviders restricts a forced-model request to exactly the given provider(s) — never the normal fallback chain, even when AI_FALLBACK_PROVIDER is configured", async () => {
    process.env.AI_FALLBACK_PROVIDER = "groq";

    const failingOpenRouter = fakeProvider({
      name: "openrouter",
      complete: vi.fn().mockRejectedValue(new AiError({ code: "model_not_found", provider: "openrouter", message: "model not found" })),
    });
    const groqProvider = fakeProvider({ name: "groq", complete: vi.fn() });
    vi.mocked(createProvider).mockImplementation((name) => (name === "openrouter" ? failingOpenRouter : groqProvider));

    const result = await runHermesCompletion({
      ...baseRequest,
      model: "nousresearch/hermes-3-llama-3.1-70b",
      modelProviders: ["openrouter"],
    });

    // This is the exact production incident: a model id that only exists on
    // OpenRouter must never be retried against Groq's catalog just because
    // Groq is configured as this deployment's general fallback provider.
    expect(result).toEqual({ ok: false, code: "model_not_found", message: expect.any(String) });
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith("openrouter");
    expect(groqProvider.complete).not.toHaveBeenCalled();
  });

  it("modelProviders is ignored when no model override is set — a caller can't accidentally restrict normal routing by passing it alone", async () => {
    process.env.AI_FALLBACK_PROVIDER = "groq";
    const openRouterProvider = fakeProvider({ complete: vi.fn().mockResolvedValue(fakeResponse()) });
    vi.mocked(createProvider).mockReturnValue(openRouterProvider);

    const result = await runHermesCompletion({ ...baseRequest, modelProviders: ["groq"] });

    expect(result.ok).toBe(true);
    expect(createProvider).toHaveBeenCalledWith("openrouter");
  });

  it("modelByProvider requests an explicit model only on the named provider — a genuine fallback to another provider still requests THAT provider's own default, never the named model's id", async () => {
    process.env.AI_FALLBACK_PROVIDER = "groq";

    const failingPrimary = fakeProvider({
      name: "openrouter",
      complete: vi.fn().mockRejectedValue(new AiError({ code: "provider_unavailable", provider: "openrouter", message: "down" })),
    });
    const workingFallback = fakeProvider({
      name: "groq",
      complete: vi.fn().mockResolvedValue(fakeResponse({ provider: "groq", model: "openai/gpt-oss-120b" })),
    });
    vi.mocked(createProvider).mockImplementation((name) => (name === "openrouter" ? failingPrimary : workingFallback));

    const result = await runHermesCompletion({
      ...baseRequest,
      modelByProvider: { openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free" },
    });

    expect(result).toEqual({ ok: true, text: "a real suggestion", provider: "groq", model: "openai/gpt-oss-120b" });
    // OpenRouter was asked for the named model...
    expect(vi.mocked(failingPrimary.complete).mock.calls[0][0].model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    // ...but Groq — the genuine fallback, not named in modelByProvider — was
    // asked for nothing at all, so it requests its own configured default,
    // never OpenRouter's model id (which it doesn't have and would 404 on).
    expect(vi.mocked(workingFallback.complete).mock.calls[0][0].model).toBeUndefined();
  });

  it("honestly records requestedProvider/requestedModel distinct from the actual serving provider/model when a fallback occurs — this is the fix for the Nemotron/Groq routing divergence", async () => {
    process.env.AI_FALLBACK_PROVIDER = "groq";

    const failingPrimary = fakeProvider({
      name: "openrouter",
      complete: vi.fn().mockRejectedValue(new AiError({ code: "provider_unavailable", provider: "openrouter", message: "down" })),
    });
    const workingFallback = fakeProvider({
      name: "groq",
      complete: vi.fn().mockResolvedValue(fakeResponse({ provider: "groq", model: "openai/gpt-oss-120b" })),
    });
    vi.mocked(createProvider).mockImplementation((name) => (name === "openrouter" ? failingPrimary : workingFallback));

    await runHermesCompletion({
      ...baseRequest,
      modelByProvider: { openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free" },
    });

    const completionUpdate = updateSpy.mock.calls.find(([payload]) => (payload as { status?: string }).status === "completed");
    expect(completionUpdate?.[0]).toMatchObject({
      output: expect.objectContaining({
        requestedProvider: "openrouter",
        requestedModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
        provider: "groq",
        model: "openai/gpt-oss-120b",
        usedFallback: true,
      }),
    });
  });

  it("records requestedModel as null when no call site names an explicit model — nothing to compare a served model against, honestly", async () => {
    vi.mocked(createProvider).mockReturnValue(fakeProvider());

    await runHermesCompletion(baseRequest);

    const completionUpdate = updateSpy.mock.calls.find(([payload]) => (payload as { status?: string }).status === "completed");
    expect(completionUpdate?.[0]).toMatchObject({ output: expect.objectContaining({ requestedModel: null }) });
  });

  it("uses an explicitly passed client for its own agent_runs/model_usage telemetry instead of the default cookie-based one — this is what lets a scheduled/cron call (no signed-in user) actually persist telemetry, since that default client's writes are otherwise silently rejected by RLS", async () => {
    vi.mocked(createProvider).mockReturnValue(fakeProvider());

    const explicitInsertSpy = vi.fn();
    const explicitUpdateSpy = vi.fn();
    const explicitClient = {
      from: () => ({
        insert: (payload: unknown) => {
          explicitInsertSpy(payload);
          return { select: () => ({ single: async () => ({ data: { id: "explicit-run-1" }, error: null }) }) };
        },
        update: (payload: unknown) => {
          explicitUpdateSpy(payload);
          return { eq: async () => ({ error: null }) };
        },
      }),
    } as unknown as Parameters<typeof runHermesCompletion>[0]["client"];

    const result = await runHermesCompletion({ ...baseRequest, client: explicitClient });

    expect(result.ok).toBe(true);
    // Both agent_runs (createAgentRun/completeAgentRun) and model_usage
    // (recordModelUsage) writes went through the explicitly passed client...
    expect(explicitInsertSpy).toHaveBeenCalled();
    expect(explicitUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    // ...and NOT through the default cookie-based client's own spies —
    // proving this call never fell back to createClient() at all.
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("accurately records the actual provider and model that served a modelProviders-restricted request", async () => {
    const completeSpy = vi.fn().mockResolvedValue(fakeResponse({ provider: "openrouter", model: "nousresearch/hermes-3-llama-3.1-70b" }));
    vi.mocked(createProvider).mockReturnValue(fakeProvider({ complete: completeSpy }));

    const result = await runHermesCompletion({
      ...baseRequest,
      model: "nousresearch/hermes-3-llama-3.1-70b",
      modelProviders: ["openrouter"],
    });

    expect(result).toEqual({ ok: true, text: "a real suggestion", provider: "openrouter", model: "nousresearch/hermes-3-llama-3.1-70b" });
    const completionUpdate = updateSpy.mock.calls.find(([payload]) => (payload as { status?: string }).status === "completed");
    expect(completionUpdate?.[0]).toMatchObject({
      output: expect.objectContaining({ provider: "openrouter", model: "nousresearch/hermes-3-llama-3.1-70b", usedFallback: false }),
    });
  });

  it("records the task type and routing decision on the agent_runs row", async () => {
    vi.mocked(createProvider).mockReturnValue(fakeProvider());

    await runHermesCompletion({ ...baseRequest, taskType: "CAMPAIGN_PLANNING" });

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_type: "ask_ai_sidekick",
        input: expect.objectContaining({ taskType: "CAMPAIGN_PLANNING", preferredProvider: "openrouter" }),
      })
    );
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        output: expect.objectContaining({ taskType: "CAMPAIGN_PLANNING", provider: "openrouter", usedFallback: false }),
      })
    );
  });

  describe("rate-limit coordination across concurrent calls", () => {
    it("waits out a cooldown a sibling call already recorded for this provider before attempting it — this is what stops several concurrently-researched leads from all hammering a just-rate-limited provider at once", async () => {
      recordProviderRateLimit("openrouter", 300);
      const completeSpy = vi.fn().mockResolvedValue(fakeResponse());
      vi.mocked(createProvider).mockReturnValue(fakeProvider({ complete: completeSpy }));

      const startedAt = Date.now();
      const result = await runHermesCompletion(baseRequest);

      expect(result.ok).toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      expect(completeSpy).toHaveBeenCalledTimes(1);
    }, 10000);

    it("never waits on a cooldown recorded for a different provider", async () => {
      recordProviderRateLimit("groq", 3000); // must never leak onto an openrouter call
      const completeSpy = vi.fn().mockResolvedValue(fakeResponse());
      vi.mocked(createProvider).mockReturnValue(fakeProvider({ complete: completeSpy }));

      const startedAt = Date.now();
      await runHermesCompletion(baseRequest);

      expect(Date.now() - startedAt).toBeLessThan(200);
    });

    it("records a cooldown for the provider that actually got rate-limited, and only that provider", async () => {
      const rateLimited = new AiError({
        code: "rate_limited",
        provider: "openrouter",
        message: "Rate limit reached ... Please try again in 50ms.",
        statusCode: 429,
        retryAfterMs: 50,
      });
      vi.mocked(createProvider).mockReturnValue(fakeProvider({ complete: vi.fn().mockRejectedValue(rateLimited) }));

      await runHermesCompletion(baseRequest);

      expect(getProviderCooldownMs("openrouter")).toBeGreaterThan(0);
      expect(getProviderCooldownMs("groq")).toBe(0);
    });

    it("a rate-limited primary still falls back to Groq normally — the coordination guard only delays a call, it never blocks the fallback chain itself", async () => {
      process.env.AI_FALLBACK_PROVIDER = "groq";
      const rateLimited = new AiError({
        code: "rate_limited",
        provider: "openrouter",
        message: "Rate limit reached ... Please try again in 50ms.",
        statusCode: 429,
        retryAfterMs: 50,
      });
      const failingPrimary = fakeProvider({ name: "openrouter", complete: vi.fn().mockRejectedValue(rateLimited) });
      const workingFallback = fakeProvider({
        name: "groq",
        complete: vi.fn().mockResolvedValue(fakeResponse({ provider: "groq", model: "openai/gpt-oss-120b" })),
      });
      vi.mocked(createProvider).mockImplementation((name) => (name === "openrouter" ? failingPrimary : workingFallback));

      const result = await runHermesCompletion(baseRequest);

      expect(result).toEqual({ ok: true, text: "a real suggestion", provider: "groq", model: "openai/gpt-oss-120b" });
      expect(workingFallback.complete).toHaveBeenCalledTimes(1);
    }, 10000);
  });

  describe("tool calling (enableTools)", () => {
    it("does not request tools or execute anything when enableTools is unset", async () => {
      const provider = fakeProvider();
      vi.mocked(createProvider).mockReturnValue(provider);

      await runHermesCompletion(baseRequest);

      expect(provider.complete).toHaveBeenCalledTimes(1);
      const call = vi.mocked(provider.complete).mock.calls[0][0];
      expect(call.tools).toBeUndefined();
      expect(executeTool).not.toHaveBeenCalled();
    });

    it("executes a requested tool call and re-queries the provider with the result before returning", async () => {
      const toolCallResponse = fakeResponse({
        text: null,
        toolCalls: [{ id: "call_1", name: "lookup_lead", arguments: '{"leadId":"lead-1"}' }],
      });
      const finalResponse = fakeResponse({ text: "Priya Sharma is your top lead, follow up today." });
      const complete = vi.fn().mockResolvedValueOnce(toolCallResponse).mockResolvedValueOnce(finalResponse);
      vi.mocked(createProvider).mockReturnValue(fakeProvider({ complete }));
      vi.mocked(executeTool).mockResolvedValue({ ok: true, data: { id: "lead-1", current_score: 82 } });

      const result = await runHermesCompletion({ ...baseRequest, organizationId: "org-1", enableTools: true });

      expect(result).toEqual({
        ok: true,
        text: "Priya Sharma is your top lead, follow up today.",
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });
      expect(complete).toHaveBeenCalledTimes(2);
      expect(executeTool).toHaveBeenCalledWith("org-1", "lookup_lead", '{"leadId":"lead-1"}');

      // The follow-up call must replay the tool call and its result as history.
      const secondCallArgs = complete.mock.calls[1][0];
      const roles = secondCallArgs.messages.map((m: { role: string }) => m.role);
      expect(roles).toEqual(["system", "user", "assistant", "tool"]);
      expect(secondCallArgs.messages[3]).toEqual({
        role: "tool",
        toolCallId: "call_1",
        content: JSON.stringify({ ok: true, data: { id: "lead-1", current_score: 82 } }),
      });
    });

    it("bounds the tool-call loop instead of looping forever when the model keeps requesting tools", async () => {
      const alwaysToolCalls = fakeResponse({
        text: null,
        toolCalls: [{ id: "call_x", name: "lookup_lead", arguments: "{}" }],
      });
      const complete = vi.fn().mockResolvedValue(alwaysToolCalls);
      vi.mocked(createProvider).mockReturnValue(fakeProvider({ complete }));
      vi.mocked(executeTool).mockResolvedValue({ ok: false, error: "invalid arguments" });

      const result = await runHermesCompletion({ ...baseRequest, organizationId: "org-1", enableTools: true });

      // MAX_TOOL_ROUNDS (2) extra attempts beyond the first call = 3 total.
      expect(complete).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ ok: false, code: "malformed_response", message: expect.any(String) });
    });

    it("never attempts tool execution when there is no organizationId, even with enableTools set", async () => {
      const provider = fakeProvider();
      vi.mocked(createProvider).mockReturnValue(provider);

      const result = await runHermesCompletion({ ...baseRequest, organizationId: null, enableTools: true });

      expect(result.ok).toBe(true);
      expect(provider.complete).toHaveBeenCalledTimes(1);
      const call = vi.mocked(provider.complete).mock.calls[0][0];
      expect(call.tools).toBeUndefined();
      expect(executeTool).not.toHaveBeenCalled();
    });
  });
});
