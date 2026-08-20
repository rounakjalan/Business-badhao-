import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runFollowUp } from "@/lib/ai/agents/follow-up";

const VALID_PLAN = {
  followUpTiming: "in 3-4 days",
  followUpMessage: "Just checking in — any questions about the demo?",
  educationalContentSuggestion: null,
  objectionHandling: [],
  nurtureStatus: "nurture_soon",
};

const baseInput = {
  organizationId: "org-1",
  leadName: "Rohit Verma",
  channel: "email",
  detectedIntent: "CURIOUS",
  messages: [{ direction: "inbound", senderType: "lead", body: "Let me think about it." }],
  businessContext: null,
};

describe("runFollowUp", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated follow-up plan on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_PLAN),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runFollowUp(baseInput);
    expect(result).toEqual({ ok: true, plan: VALID_PLAN });
  });

  it("rejects an invalid nurtureStatus", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_PLAN, nurtureStatus: "give_up" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runFollowUp(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "timeout", message: "The AI provider took too long to respond. Try again." });
    const result = await runFollowUp(baseInput);
    expect(result.ok).toBe(false);
  });

  it("does not fail when there is no business context", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_PLAN), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await runFollowUp({ ...baseInput, businessContext: null });
    expect(result.ok).toBe(true);
  });

  it("includes FAQs and relevant policies in the actual Hermes request, alongside the real conversation", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_PLAN), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runFollowUp({
      ...baseInput,
      businessContext: {
        businessProfile: null,
        productsServices: [],
        valueProposition: { keySellingPoints: [], productBenefits: [] },
        faqs: [{ question: "Do you offer a trial?", answer: "Yes, a 7-day free trial.", category: null }],
        policies: [{ policyType: "cancellation", title: "Cancellation Policy", content: "Cancel anytime, no fees." }],
        aiCommunicationRules: null,
        mediaReferences: [],
      },
    });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("7-day free trial");
    expect(prompt).toContain("Cancel anytime, no fees");
    expect(prompt).toContain("Let me think about it."); // real conversation still present alongside Business Knowledge
  });
});
