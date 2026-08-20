import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runLossAnalysis } from "@/lib/ai/agents/loss-analysis";

const VALID_ANALYSIS = {
  primaryReason: "price",
  secondaryReasons: ["timing"],
  summary: "The lead cited budget constraints and went quiet after the quote.",
  rootCause: "Quote exceeded their stated budget by a wide margin.",
  lessons: ["Qualify budget earlier"],
  recommendedCampaignChanges: ["Ask about budget range in the first message"],
  recommendedIcpChanges: [],
  recommendedOutreachChanges: ["Lead with value before price"],
};

const baseInput = {
  organizationId: "org-1",
  dealTitle: "Acme <> Retailer X",
  value: 45000,
  currency: "INR",
  humanSelectedReason: "Price",
  leadName: "Rohit Verma",
  campaignObjective: "Book demo calls",
  messages: [{ direction: "inbound", senderType: "lead", body: "That's a bit over our budget." }],
  businessContext: null,
};

describe("runLossAnalysis", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated loss analysis on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_ANALYSIS),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLossAnalysis(baseInput);
    expect(result).toEqual({ ok: true, analysis: VALID_ANALYSIS });
  });

  it("rejects a primaryReason outside the fixed root-cause list", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_ANALYSIS, primaryReason: "bad_luck" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLossAnalysis(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "provider_unavailable", message: "The AI provider is temporarily unavailable." });
    const result = await runLossAnalysis(baseInput);
    expect(result.ok).toBe(false);
  });

  it("does not fail when there is no business context", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_ANALYSIS), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await runLossAnalysis({ ...baseInput, businessContext: null });
    expect(result.ok).toBe(true);
  });

  it("includes product pricing and policies in the actual Hermes request, alongside real deal/conversation evidence", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_ANALYSIS), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runLossAnalysis({
      ...baseInput,
      businessContext: {
        businessProfile: null,
        productsServices: [{ name: "Standard Plan", description: null, category: null, price: 45000, pricingType: "fixed", features: [], benefits: [], availability: "available", specialOffers: null }],
        valueProposition: { keySellingPoints: [], productBenefits: [] },
        faqs: [],
        policies: [{ policyType: "refund", title: "Refund Policy", content: "No refunds after service starts." }],
        aiCommunicationRules: null,
        mediaReferences: [],
      },
    });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("Standard Plan");
    expect(prompt).toContain("No refunds after service starts");
    expect(prompt).toContain("That's a bit over our budget."); // real conversation evidence still present
  });
});
