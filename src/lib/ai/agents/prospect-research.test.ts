import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessContext } from "@/lib/business-context";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runProspectResearch } from "@/lib/ai/agents/prospect-research";

const VALID_RESEARCH = {
  companySummary: "A local retail store with an online presence.",
  likelyNeeds: ["more foot traffic"],
  possiblePainPoints: ["low online visibility"],
  relevantProductsOrServices: ["social media ads"],
  buyingSignals: [],
  personalizationOpportunities: ["mention their website"],
  potentialObjections: ["cost"],
  confidence: "low",
  verifiedInformation: ["has a website"],
  businessFactsReferenced: [],
  inferredInformation: ["likely a small business"],
  unavailableInformation: ["employee count", "revenue"],
};

const baseInput = {
  organizationId: "org-1",
  leadName: "Priya Sharma",
  companyName: "Sharma Retailers",
  website: "sharmaretail.example",
  title: null,
  campaignName: "Q1 Push",
  campaignObjective: "Book demo calls",
  businessContext: null,
};

const RESEARCH_BUSINESS_CONTEXT: BusinessContext = {
  businessProfile: { name: "Acme Ads", description: null, category: "Marketing agency", about: null, website: null, phone: null, email: null, whatsapp: null, address: null, serviceArea: "Delhi NCR", openingHours: null },
  productsServices: [{ name: "Social Media Ad Management", description: null, category: null, price: null, pricingType: "custom", features: [], benefits: [], availability: "available", specialOffers: null }],
  valueProposition: { keySellingPoints: ["10 years running local campaigns"], productBenefits: [] },
  faqs: [],
  policies: [],
  aiCommunicationRules: null,
  mediaReferences: [],
};

describe("runProspectResearch", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns validated research on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_RESEARCH),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runProspectResearch(baseInput);
    expect(result).toEqual({ ok: true, research: VALID_RESEARCH });
  });

  it("rejects a response with an invalid confidence value", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_RESEARCH, confidence: "certain" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runProspectResearch(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "network_error", message: "Couldn't reach the AI provider. Try again in a moment." });
    const result = await runProspectResearch(baseInput);
    expect(result.ok).toBe(false);
  });

  it("does not fail when there is no business context", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_RESEARCH), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    const result = await runProspectResearch({ ...baseInput, businessContext: null });

    expect(result.ok).toBe(true);
    expect(vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt).toContain("No Business Knowledge is on file");
  });

  it("includes the supplied Business Knowledge in the actual Hermes request", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_RESEARCH), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runProspectResearch({ ...baseInput, businessContext: RESEARCH_BUSINESS_CONTEXT });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("Social Media Ad Management");
    expect(prompt).toContain("10 years running local campaigns");
  });
});
