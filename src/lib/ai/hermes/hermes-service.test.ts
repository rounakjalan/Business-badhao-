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
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    vi.clearAllMocks();
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
