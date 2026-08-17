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

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: "run-1" }, error: null }),
        }),
      }),
      update: () => ({
        eq: async () => ({ error: null }),
      }),
    }),
  })),
}));

import { createProvider } from "@/lib/ai/providers/registry";
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

  it("treats an unconfigured provider as not_configured without calling complete()", async () => {
    const provider = fakeProvider({ isConfigured: () => false, complete: vi.fn() });
    vi.mocked(createProvider).mockReturnValue(provider);

    const result = await runHermesCompletion(baseRequest);

    expect(result).toEqual({ ok: false, code: "not_configured", message: expect.any(String) });
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
