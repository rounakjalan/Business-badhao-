import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runLeadQualification, runDiscoveryQualification, QUALIFICATION_STATUSES } from "@/lib/ai/agents/qualification";

const VALID_QUALIFICATION = {
  qualificationScore: 78,
  fitScore: 80,
  intentScore: 60,
  confidence: "medium",
  positiveReasons: ["matches ICP industry"],
  negativeReasons: ["no budget signal yet"],
  missingInformation: ["company size"],
  recommendedStatus: "qualifying",
};

const baseInput = {
  organizationId: "org-1",
  leadName: "Priya Sharma",
  companyName: "Sharma Retailers",
  currentStatus: "new",
  currentScore: null,
  researchSummary: null,
  icpCriteria: null,
  campaignObjective: "Book demo calls",
  businessContext: null,
};

describe("runLeadQualification", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated qualification on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_QUALIFICATION),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification(baseInput);
    expect(result).toEqual({ ok: true, qualification: VALID_QUALIFICATION });
  });

  it("only ever recommends a status the leads.qualification_status column actually accepts", () => {
    expect(QUALIFICATION_STATUSES).toEqual(["pending", "qualifying", "qualified", "disqualified"]);
  });

  it("rejects a recommendedStatus outside the schema's allowed values", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_QUALIFICATION, recommendedStatus: "HIGH_INTENT" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification(baseInput);
    expect(result.ok).toBe(false);
  });

  it("rejects an out-of-range score", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_QUALIFICATION, qualificationScore: 150 }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "timeout", message: "The AI provider took too long to respond. Try again." });
    const result = await runLeadQualification(baseInput);
    expect(result).toEqual({ ok: false, message: "The AI provider took too long to respond. Try again." });
  });

  it("sends business context and campaign ICP in the actual request, as clearly separate sections", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runLeadQualification({
      ...baseInput,
      icpCriteria: { targetMarket: "Retail store owners" },
      businessContext: {
        businessProfile: null,
        productsServices: [{ name: "Store Growth Package", description: null, category: null, price: null, pricingType: "custom", features: [], benefits: [], availability: "available", specialOffers: null }],
        valueProposition: { keySellingPoints: [], productBenefits: [] },
        faqs: [],
        policies: [],
        aiCommunicationRules: null,
        mediaReferences: [],
      },
    });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    const businessKnowledgeIdx = prompt.indexOf("=== BUSINESS KNOWLEDGE");
    const icpIdx = prompt.indexOf("=== CAMPAIGN ICP");

    expect(prompt).toContain("Store Growth Package");
    expect(businessKnowledgeIdx).toBeGreaterThanOrEqual(0);
    expect(icpIdx).toBeGreaterThan(businessKnowledgeIdx);
    expect(prompt.indexOf("Retail store owners")).toBeGreaterThan(icpIdx); // ICP data lives after the ICP header, not mixed into Business Knowledge
  });

  it("does not fail when there is no business context or ICP", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    const result = await runLeadQualification({ ...baseInput, businessContext: null, icpCriteria: null });

    expect(result.ok).toBe(true);
  });
});

describe("runDiscoveryQualification (automatic triage after discovery)", () => {
  afterEach(() => vi.clearAllMocks());

  const prospects = [
    {
      companyName: "Sharma Packaging Industries",
      location: "Noida",
      industry: "Manufacturing",
      website: null,
      sourceUrl: "https://directory.example/noida/packaging",
      evidenceSnippet: "Sharma Packaging Industries — corrugated box manufacturer in Sector 63, Noida.",
    },
    {
      companyName: "Mumbai Steel Corp",
      location: "Mumbai",
      industry: "Manufacturing",
      website: null,
      sourceUrl: "https://directory.example/noida/packaging",
      evidenceSnippet: "Mumbai Steel Corp — steel supplier headquartered in Mumbai.",
    },
  ];

  const baseDiscoveryInput = {
    organizationId: "org-1",
    campaignObjective: "Get more customers",
    icpCriteria: { location: "Noida", businessType: "Small to medium enterprise", disqualifiers: ["Business located outside Noida"] },
    businessContext: null,
    prospects,
  };

  const ASSESSMENTS = {
    assessments: [
      {
        companyName: "Sharma Packaging Industries",
        qualificationScore: 72,
        confidence: "medium",
        recommendedStatus: "qualifying",
        positiveReasons: ["Located in Noida", "SME manufacturer"],
        negativeReasons: [],
      },
      {
        companyName: "Mumbai Steel Corp",
        qualificationScore: 8,
        confidence: "high",
        recommendedStatus: "disqualified",
        positiveReasons: [],
        negativeReasons: ["Located outside Noida, matching a stated disqualifier"],
      },
    ],
  };

  it("4/5. qualifies a matching prospect and disqualifies one that contradicts the ICP, in a single request", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(ASSESSMENTS), provider: "groq", model: "m" });

    const result = await runDiscoveryQualification(baseDiscoveryInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.assessments).toHaveLength(2);
    expect(result.assessments[0]).toMatchObject({ companyName: "Sharma Packaging Industries", recommendedStatus: "qualifying" });
    expect(result.assessments[1]).toMatchObject({ companyName: "Mumbai Steel Corp", recommendedStatus: "disqualified" });
    // One request for the whole run — per-lead scoring exceeds the provider's per-minute budget.
    expect(vi.mocked(runHermesCompletion)).toHaveBeenCalledTimes(1);
  });

  it("receives Business Knowledge, the ICP and each prospect's source URL and evidence", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(ASSESSMENTS), provider: "groq", model: "m" });

    await runDiscoveryQualification({
      ...baseDiscoveryInput,
      businessContext: {
        businessProfile: null,
        productsServices: [{ name: "Website Redesign", description: null, category: null, price: null, pricingType: "custom", features: [], benefits: [], availability: "available", specialOffers: null }],
        valueProposition: { keySellingPoints: [], productBenefits: [] },
        faqs: [],
        policies: [],
        aiCommunicationRules: null,
        mediaReferences: [],
      },
    });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("Website Redesign");
    expect(prompt).toContain("BUSINESS KNOWLEDGE");
    expect(prompt).toContain("CAMPAIGN ICP");
    expect(prompt).toContain("https://directory.example/noida/packaging");
    expect(prompt).toContain("corrugated box manufacturer");
    // Seller knowledge and buyer targeting stay clearly separate concepts.
    expect(prompt.indexOf("CAMPAIGN ICP")).toBeGreaterThan(prompt.indexOf("BUSINESS KNOWLEDGE"));
  });

  it("never invents a prospect: an assessment schema violation is rejected outright", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ assessments: [{ ...ASSESSMENTS.assessments[0], recommendedStatus: "VERY_HOT" }] }),
      provider: "groq",
      model: "m",
    });

    const result = await runDiscoveryQualification(baseDiscoveryInput);
    expect(result.ok).toBe(false);
  });

  it("skips the request entirely when a run produced no prospects", async () => {
    const result = await runDiscoveryQualification({ ...baseDiscoveryInput, prospects: [] });
    expect(result).toEqual({ ok: true, assessments: [] });
    expect(vi.mocked(runHermesCompletion)).not.toHaveBeenCalled();
  });

  it("propagates a provider failure so the caller can leave the leads pending", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "rate_limited", message: "The AI provider is rate-limiting requests right now — try again shortly." });
    const result = await runDiscoveryQualification(baseDiscoveryInput);
    expect(result.ok).toBe(false);
  });
});
