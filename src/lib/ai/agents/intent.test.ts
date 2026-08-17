import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { detectIntent, HIGH_INTENT_CATEGORIES } from "@/lib/ai/agents/intent";

const VALID_ANALYSIS = {
  intent: "HIGH_INTENT",
  confidence: "high",
  reasoning: "Asked for a payment link directly.",
  detectedObjections: [],
  detectedBuyingSignals: ["asked for payment link"],
  recommendedNextAction: "Send payment link",
};

const baseInput = {
  organizationId: "org-1",
  leadName: "Rohit Verma",
  channel: "whatsapp",
  messages: [{ direction: "inbound", senderType: "lead", body: "Can you send the payment link?" }],
};

describe("detectIntent", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated intent analysis on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_ANALYSIS),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await detectIntent(baseInput);
    expect(result).toEqual({ ok: true, analysis: VALID_ANALYSIS });
  });

  it("classifies HIGH_INTENT and READY_TO_BUY as the high-intent set, and nothing else", () => {
    expect(HIGH_INTENT_CATEGORIES.has("HIGH_INTENT")).toBe(true);
    expect(HIGH_INTENT_CATEGORIES.has("READY_TO_BUY")).toBe(true);
    expect(HIGH_INTENT_CATEGORIES.has("CURIOUS")).toBe(false);
    expect(HIGH_INTENT_CATEGORIES.has("LOW_INTENT")).toBe(false);
  });

  it("rejects an intent value outside the fixed category list", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_ANALYSIS, intent: "SUPER_EXCITED" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await detectIntent(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "rate_limited", message: "The AI provider is rate-limiting requests right now — try again shortly." });
    const result = await detectIntent(baseInput);
    expect(result.ok).toBe(false);
  });
});
