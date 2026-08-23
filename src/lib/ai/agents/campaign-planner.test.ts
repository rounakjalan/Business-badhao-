import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessContext } from "@/lib/business-context";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runCampaignPlanner, diffPlanFields } from "@/lib/ai/agents/campaign-planner";

const VALID_PLAN = {
  objective: "Book 20 demo calls",
  targetMarket: "Retail store owners",
  customerProfile: "Small retail owners in NCR",
  idealCustomerCharacteristics: ["owns a shop", "sells electronics"],
  buyingSignals: ["asked about pricing"],
  painPoints: ["low foot traffic"],
  valueProposition: "Reach more customers online",
  suggestedChannels: ["WhatsApp", "Instagram"],
  campaignStrategy: "Outbound WhatsApp with a soft offer",
  qualificationCriteria: ["has a physical store"],
  outreachStrategy: "Personalized WhatsApp intro",
  followUpStrategy: "Follow up after 3 days",
};

const baseInput = {
  organizationId: "org-1",
  organizationName: "Acme",
  campaignName: "Q1 Push",
  objective: "Get more customers",
  description: "",
  customerType: "retail owners",
  location: "Delhi",
  businessContext: null,
};

const FULL_BUSINESS_CONTEXT: BusinessContext = {
  businessProfile: {
    name: "Acme Electronics",
    description: "Neighborhood electronics retailer",
    category: "Retail electronics",
    about: null,
    website: null,
    phone: null,
    email: null,
    whatsapp: null,
    address: null,
    serviceArea: "Delhi NCR",
    openingHours: null,
  },
  productsServices: [
    {
      name: "Home Theatre Installation",
      description: "Full setup and calibration",
      category: "Installation",
      price: 4999,
      pricingType: "fixed",
      features: ["Wall mounting", "Cable management"],
      benefits: ["Same-day service"],
      availability: "available",
      specialOffers: "10% off in March",
    },
  ],
  valueProposition: { keySellingPoints: ["Only certified installers in the area"], productBenefits: ["Same-day service"] },
  faqs: [{ question: "Do you offer warranty?", answer: "Yes, 1 year on installation.", category: "Warranty" }],
  policies: [{ policyType: "refund", title: "Refund Policy", content: "Full refund within 7 days if uninstalled." }],
  aiCommunicationRules: {
    brandVoice: "Friendly and technical",
    preferredLanguage: "English",
    formality: "Casual",
    mustEmphasize: ["Certified installers"],
    mustNeverClaim: ["Same-day service outside Delhi NCR"],
    competitorComparisonRules: null,
    discountAuthority: null,
    escalationRules: null,
    handoffTriggers: ["Customer asks for a refund"],
  },
  mediaReferences: [{ category: "brochure", title: "2026 Catalogue", fileName: "catalogue.pdf" }],
};

describe("runCampaignPlanner", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated plan on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_PLAN),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runCampaignPlanner(baseInput);

    expect(result).toEqual({ ok: true, plan: VALID_PLAN, changedFields: [] });
    expect(vi.mocked(runHermesCompletion)).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", agentType: "campaign_planner", responseFormat: "json" })
    );
  });

  it("propagates a Hermes-level failure without pretending to have a plan", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "not_configured", message: "The AI assistant isn't connected yet." });

    const result = await runCampaignPlanner(baseInput);

    expect(result).toEqual({ ok: false, message: "The AI assistant isn't connected yet." });
  });

  it("rejects a response missing required fields rather than saving partial/invalid data", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ objective: "Book calls" }), // missing everything else
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runCampaignPlanner(baseInput);

    expect(result.ok).toBe(false);
  });

  it("rejects a response that isn't JSON at all", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: "Sure! Here's a great campaign idea for you.",
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runCampaignPlanner(baseInput);

    expect(result.ok).toBe(false);
  });

  describe("business context integration", () => {
    it("does not fail when the organization has no Business Knowledge on file", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValue({
        ok: true,
        text: JSON.stringify(VALID_PLAN),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      const result = await runCampaignPlanner({ ...baseInput, businessContext: null });

      expect(result).toEqual({ ok: true, plan: VALID_PLAN, changedFields: [] });
      const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
      expect(call.userPrompt).toContain("No Business Knowledge is on file for this organization yet.");
    });

    it("sends products/services, FAQs, policies, and AI communication rules as a structured, labeled business-knowledge block", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValue({
        ok: true,
        text: JSON.stringify(VALID_PLAN),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      await runCampaignPlanner({ ...baseInput, businessContext: FULL_BUSINESS_CONTEXT });

      const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;

      // Products/services
      expect(prompt).toContain("PRODUCTS / SERVICES:");
      expect(prompt).toContain("Home Theatre Installation");
      // FAQs
      expect(prompt).toContain("FAQs:");
      expect(prompt).toContain("Do you offer warranty?");
      // Policies
      expect(prompt).toContain("BUSINESS POLICIES:");
      expect(prompt).toContain("Full refund within 7 days if uninstalled.");
      // AI communication rules
      expect(prompt).toContain("AI COMMUNICATION RULES:");
      expect(prompt).toContain("Must NEVER claim: Same-day service outside Delhi NCR");
    });

    it("keeps Business Knowledge and campaign input in clearly separate, labeled sections of the same prompt", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValue({
        ok: true,
        text: JSON.stringify(VALID_PLAN),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      await runCampaignPlanner({ ...baseInput, campaignName: "Spring Sale", businessContext: FULL_BUSINESS_CONTEXT });

      const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
      const businessKnowledgeIdx = prompt.indexOf("=== BUSINESS KNOWLEDGE");
      const campaignInputIdx = prompt.indexOf("=== CAMPAIGN INPUT");

      expect(businessKnowledgeIdx).toBeGreaterThanOrEqual(0);
      expect(campaignInputIdx).toBeGreaterThan(businessKnowledgeIdx);
      // The campaign's own name lives in the CAMPAIGN INPUT section, not mixed into BUSINESS KNOWLEDGE.
      expect(prompt.indexOf("Spring Sale")).toBeGreaterThan(campaignInputIdx);
    });

    it("instructs the model that Business Knowledge is authoritative and must not be fabricated beyond", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValue({
        ok: true,
        text: JSON.stringify(VALID_PLAN),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      await runCampaignPlanner({ ...baseInput, businessContext: FULL_BUSINESS_CONTEXT });

      const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
      expect(call.systemPrompt).toContain("authoritative");
      expect(call.systemPrompt.toLowerCase()).toContain("never invent a product, price, policy");
    });
  });
});

describe("revising an existing plan", () => {
  afterEach(() => vi.clearAllMocks());

  const REVISED = { ...VALID_PLAN, targetMarket: "Clinics only", suggestedChannels: ["Email"] };

  const refineInput = {
    ...baseInput,
    currentPlan: VALID_PLAN,
    refinementRequest: "Focus only on clinics and drop WhatsApp.",
  };

  it("edits the plan instead of writing a new one: sends the current plan and the request", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(REVISED), provider: "groq", model: "m" });

    await runCampaignPlanner(refineInput);

    const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
    expect(call.userPrompt).toContain("=== CURRENT PLAN");
    expect(call.userPrompt).toContain("=== REQUESTED CHANGES");
    expect(call.userPrompt).toContain("Focus only on clinics");
    // The plan being revised is actually in the prompt, not just described.
    expect(call.userPrompt).toContain("Book 20 demo calls");
    // And the model is told to preserve, which is what makes this a revision.
    expect(call.systemPrompt).toContain("not replace it");
    expect(call.systemPrompt).toContain("EXACTLY as it is");
  });

  it("still sends Business Knowledge when revising, so edits stay grounded", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(REVISED), provider: "groq", model: "m" });

    await runCampaignPlanner({ ...refineInput, businessContext: FULL_BUSINESS_CONTEXT });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("=== BUSINESS KNOWLEDGE");
    expect(prompt.indexOf("=== CURRENT PLAN")).toBeGreaterThan(prompt.indexOf("=== BUSINESS KNOWLEDGE"));
  });

  it("reports exactly which fields the revision changed", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(REVISED), provider: "groq", model: "m" });

    const result = await runCampaignPlanner(refineInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.changedFields.sort()).toEqual(["suggestedChannels", "targetMarket"]);
  });

  it("reports no changes when the model returns the plan untouched", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_PLAN), provider: "groq", model: "m" });

    const result = await runCampaignPlanner(refineInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.changedFields).toEqual([]);
  });

  it("treats a plan with no request, or a request with no plan, as a normal generation", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_PLAN), provider: "groq", model: "m" });

    await runCampaignPlanner({ ...baseInput, currentPlan: VALID_PLAN, refinementRequest: "   " });
    expect(vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt).not.toContain("=== CURRENT PLAN");

    vi.mocked(runHermesCompletion).mockClear();
    await runCampaignPlanner({ ...baseInput, refinementRequest: "make it shorter" });
    expect(vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt).not.toContain("=== REQUESTED CHANGES");
  });

  it("a first-time generation reports no changed fields", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_PLAN), provider: "groq", model: "m" });

    const result = await runCampaignPlanner(baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.changedFields).toEqual([]);
  });
});

describe("diffPlanFields", () => {
  it("sees a changed string field", () => {
    expect(diffPlanFields(VALID_PLAN, { ...VALID_PLAN, valueProposition: "different" })).toEqual(["valueProposition"]);
  });

  it("sees list edits, including reordering and length changes", () => {
    expect(diffPlanFields(VALID_PLAN, { ...VALID_PLAN, suggestedChannels: ["Instagram", "WhatsApp"] })).toEqual(["suggestedChannels"]);
    expect(diffPlanFields(VALID_PLAN, { ...VALID_PLAN, painPoints: ["low foot traffic", "new"] })).toEqual(["painPoints"]);
  });

  it("returns nothing for an identical plan", () => {
    expect(diffPlanFields(VALID_PLAN, { ...VALID_PLAN })).toEqual([]);
  });
});
