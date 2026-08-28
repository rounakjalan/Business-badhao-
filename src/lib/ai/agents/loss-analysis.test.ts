import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runLossAnalysis, LossAnalysisSchema } from "@/lib/ai/agents/loss-analysis";

const VALID_ANALYSIS = {
  primaryReason: "price",
  secondaryReasons: ["timing"],
  confidence: "medium",
  summary: "The lead cited budget constraints and went quiet after the quote.",
  rootCause: "Quote exceeded their stated budget by a wide margin.",
  objections: ["Said the price was over budget"],
  pricingConcerns: ["Quote was above what they expected to pay"],
  productFitConcerns: [],
  timingConcerns: [],
  competitorMentions: [],
  communicationIssues: ["Went silent after the quote was sent"],
  supportingEvidence: ["\"That's a bit over our budget.\""],
  productOrServiceInvolved: "Standard Plan",
  recoveryOpportunity: { justified: true, reasoning: "Price was the only stated objection.", suggestedApproach: "Offer a smaller starter package at a lower price point." },
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
  buyingIntentHistory: [{ at: "2026-08-20T10:00:00.000Z", buyingIntent: "medium" as const }],
  currentBuyingIntent: "medium" as const,
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

  it("rejects a response missing the new structured fields (e.g. an old-shaped response)", async () => {
    const legacyShape: Partial<typeof VALID_ANALYSIS> = { ...VALID_ANALYSIS };
    delete legacyShape.confidence;
    delete legacyShape.objections;
    delete legacyShape.recoveryOpportunity;
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(legacyShape),
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

  it("does not fail when buying-intent history is empty", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_ANALYSIS), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await runLossAnalysis({ ...baseInput, buyingIntentHistory: [], currentBuyingIntent: null });
    expect(result.ok).toBe(true);
  });

  it("includes product pricing and policies in the actual Hermes request, alongside real deal/conversation evidence and buying-intent history", async () => {
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

    const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
    const prompt = call.userPrompt;
    expect(prompt).toContain("Standard Plan");
    expect(prompt).toContain("No refunds after service starts");
    expect(prompt).toContain("That's a bit over our budget."); // real conversation evidence still present
    expect(prompt).toContain("medium"); // recorded buying-intent history, not invented by the model
    expect(call.taskType).toBe("LOSS_ANALYSIS");
  });

  it("instructs the model to ground every field in real evidence rather than inventing objections or competitors", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_ANALYSIS), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    await runLossAnalysis(baseInput);

    const systemPrompt = vi.mocked(runHermesCompletion).mock.calls[0][0].systemPrompt;
    expect(systemPrompt.toLowerCase()).toContain("never invent");
    expect(systemPrompt.toLowerCase()).toContain("empty array");
  });

  it("has no field an AI response could use to trigger contacting the lead — recoveryOpportunity is advisory text only", () => {
    const keys = Object.keys(LossAnalysisSchema.shape);
    expect(keys.some((k) => /send|contact|message|email|whatsapp|reengage/i.test(k))).toBe(false);
  });
});
