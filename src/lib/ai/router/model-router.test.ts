import { describe, expect, it } from "vitest";
import type { AiConfig } from "@/lib/ai/config";
import { resolveRouting } from "@/lib/ai/router/model-router";
import { AI_TASK_TYPES, type AiTaskType } from "@/lib/ai/router/task-types";

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return { provider: "openrouter", fallbackProvider: null, timeoutMs: 20_000, maxRetries: 1, ...overrides };
}

describe("resolveRouting", () => {
  it("prefers OpenRouter for a research/reasoning task, matching the default configured primary", () => {
    const decision = resolveRouting("CAMPAIGN_PLANNING", config());

    expect(decision.preferredProvider).toBe("openrouter");
    expect(decision.providerOrder).toEqual(["openrouter"]);
  });

  it("routes a fast-classification task (intent detection) to Groq ahead of the configured primary", () => {
    const decision = resolveRouting("INTENT_DETECTION", config({ provider: "openrouter" }));

    expect(decision.preferredProvider).toBe("groq");
    expect(decision.providerOrder).toEqual(["groq", "openrouter"]);
  });

  it("never duplicates a provider that is both the task preference and the configured primary", () => {
    const decision = resolveRouting("INTENT_DETECTION", config({ provider: "groq" }));

    expect(decision.providerOrder).toEqual(["groq"]);
  });

  it("appends the configured fallback provider after the task preference and configured primary", () => {
    const decision = resolveRouting("LOSS_ANALYSIS", config({ provider: "openrouter", fallbackProvider: "groq" }));

    expect(decision.providerOrder).toEqual(["openrouter", "groq"]);
  });

  it("does not duplicate the fallback provider when it already appears earlier in the order", () => {
    const decision = resolveRouting("INTENT_DETECTION", config({ provider: "openrouter", fallbackProvider: "groq" }));

    expect(decision.providerOrder).toEqual(["groq", "openrouter"]);
  });

  it("GENERAL_CHAT always follows the configured primary provider, ignoring the task policy table", () => {
    const decision = resolveRouting("GENERAL_CHAT", config({ provider: "groq" }));

    expect(decision.preferredProvider).toBe("groq");
    expect(decision.providerOrder).toEqual(["groq"]);
  });

  it("falls back to the configured primary provider for a task type with no explicit policy entry", () => {
    // Simulates a future AiTaskType added to the union before a policy
    // entry exists for it — the router must degrade safely, not throw.
    const decision = resolveRouting("UNMAPPED_FUTURE_TASK" as AiTaskType, config({ provider: "openrouter" }));

    expect(decision.preferredProvider).toBe("openrouter");
    expect(decision.providerOrder).toEqual(["openrouter"]);
  });

  it("produces a valid, non-empty provider order for every known task type", () => {
    for (const taskType of AI_TASK_TYPES) {
      const decision = resolveRouting(taskType, config());
      expect(decision.providerOrder.length).toBeGreaterThan(0);
      expect(decision.providerOrder).toContain(decision.preferredProvider);
    }
  });
});
