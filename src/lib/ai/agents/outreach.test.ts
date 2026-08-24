import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { generateOutreach } from "@/lib/ai/agents/outreach";

const VALID_DRAFT = {
  subject: null,
  message: "Hi Priya, following up on Sharma Retailers' online presence — happy to share a few quick ideas.",
  talkingPoints: ["online visibility"],
  personalizationUsed: ["company name"],
};

const baseInput = {
  organizationId: "org-1",
  leadName: "Priya Sharma",
  companyName: "Sharma Retailers",
  channel: "whatsapp",
  campaignName: "Q1 Push",
  campaignObjective: "Book demo calls",
  icpCriteria: null,
  researchSummary: null,
  qualificationReasons: [],
  businessContext: null,
};

describe("generateOutreach", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated draft on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_DRAFT),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await generateOutreach(baseInput);
    expect(result).toEqual({ ok: true, draft: VALID_DRAFT });
  });

  it("rejects a response missing the required message field", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ subject: null, talkingPoints: [], personalizationUsed: [] }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await generateOutreach(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "not_configured", message: "The AI assistant isn't connected yet." });
    const result = await generateOutreach(baseInput);
    expect(result.ok).toBe(false);
  });

  it("does not fail when there is no business context", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_DRAFT), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await generateOutreach({ ...baseInput, businessContext: null });
    expect(result.ok).toBe(true);
  });

  it("includes product info, value proposition, and communication rules in the actual Hermes request", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_DRAFT), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await generateOutreach({
      ...baseInput,
      businessContext: {
        businessProfile: null,
        productsServices: [{ name: "Storefront Ads Package", description: null, category: null, price: null, pricingType: "custom", features: [], benefits: [], availability: "available", specialOffers: null }],
        valueProposition: { keySellingPoints: ["Only local agency with same-week turnaround"], productBenefits: [] },
        faqs: [],
        policies: [],
        aiCommunicationRules: { brandVoice: "Warm and direct", preferredLanguage: null, formality: null, mustEmphasize: [], mustNeverClaim: ["Guaranteed sales increase"], competitorComparisonRules: null, discountAuthority: null, escalationRules: null, handoffTriggers: [] },
        mediaReferences: [],
      },
    });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("Storefront Ads Package");
    expect(prompt).toContain("Only local agency with same-week turnaround");
    expect(prompt).toContain("Guaranteed sales increase");
  });

  it("includes the campaign's ICP criteria in the actual Hermes request when given", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_DRAFT), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await generateOutreach({ ...baseInput, icpCriteria: { industry: "Retail electronics", location: "Delhi NCR" } });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("Retail electronics");
    expect(prompt).toContain("Delhi NCR");
  });

  it("does not fail when there is no ICP on file", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_DRAFT), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await generateOutreach({ ...baseInput, icpCriteria: null });
    expect(result.ok).toBe(true);
  });
});
