import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import {
  runLeadQualification,
  clampWithoutResearchEvidence,
  QUALIFICATION_STATUSES,
  type LeadQualification,
} from "@/lib/ai/agents/qualification";

const VALID_QUALIFICATION: LeadQualification = {
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

describe("clampWithoutResearchEvidence", () => {
  it("1/3. holds a 'qualified' verdict at 'qualifying' when there is no research evidence", () => {
    const clamped = clampWithoutResearchEvidence({ ...VALID_QUALIFICATION, recommendedStatus: "qualified" }, false);
    expect(clamped.recommendedStatus).toBe("qualifying");
  });

  it("1/3. holds a 'disqualified' verdict at 'qualifying' when there is no research evidence", () => {
    const clamped = clampWithoutResearchEvidence({ ...VALID_QUALIFICATION, recommendedStatus: "disqualified" }, false);
    expect(clamped.recommendedStatus).toBe("qualifying");
  });

  it("2. leaves a 'qualified' verdict untouched when research evidence exists", () => {
    const clamped = clampWithoutResearchEvidence({ ...VALID_QUALIFICATION, recommendedStatus: "qualified" }, true);
    expect(clamped.recommendedStatus).toBe("qualified");
  });

  it("leaves 'pending' and 'qualifying' verdicts untouched regardless of research evidence, since neither is a final decision", () => {
    expect(clampWithoutResearchEvidence({ ...VALID_QUALIFICATION, recommendedStatus: "pending" }, false).recommendedStatus).toBe("pending");
    expect(clampWithoutResearchEvidence({ ...VALID_QUALIFICATION, recommendedStatus: "qualifying" }, false).recommendedStatus).toBe("qualifying");
  });

  it("4. never fabricates reasons when clamping — only appends a note explaining why the verdict was held", () => {
    const clamped = clampWithoutResearchEvidence({ ...VALID_QUALIFICATION, recommendedStatus: "qualified" }, false);
    expect(clamped.positiveReasons).toEqual(VALID_QUALIFICATION.positiveReasons);
    expect(clamped.negativeReasons).toEqual(VALID_QUALIFICATION.negativeReasons);
    expect(clamped.missingInformation).toEqual([...VALID_QUALIFICATION.missingInformation, expect.stringContaining("Lead Research")]);
    // Score and reasons are the model's real output, not invented — only the final status is held back.
    expect(clamped.qualificationScore).toBe(VALID_QUALIFICATION.qualificationScore);
  });
});

describe("runLeadQualification's no-research guard", () => {
  afterEach(() => vi.clearAllMocks());

  it("1/3. discovery-time evidence alone cannot produce a final 'qualified' decision — it is held at 'qualifying'", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_QUALIFICATION, recommendedStatus: "qualified" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification({ ...baseInput, researchSummary: null });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.qualification.recommendedStatus).toBe("qualifying");
  });

  it("2. a lead with completed research can reach a final 'qualified' decision", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_QUALIFICATION, recommendedStatus: "qualified" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification({
      ...baseInput,
      researchSummary: "Sharma Retailers operates three stores in Noida and is actively hiring — a genuine research finding, not invented.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.qualification.recommendedStatus).toBe("qualified");
  });

  it("3. an empty/whitespace-only research summary is treated the same as no research on file", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_QUALIFICATION, recommendedStatus: "disqualified" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification({ ...baseInput, researchSummary: "   " });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.qualification.recommendedStatus).toBe("qualifying");
  });
});
