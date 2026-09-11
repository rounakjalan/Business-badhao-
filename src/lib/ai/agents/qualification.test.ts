import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import type { ProspectResearch } from "@/lib/ai/agents/prospect-research-schema";
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
  researchFindings: null,
  icpCriteria: null,
  campaignObjective: "Book demo calls",
  businessContext: null,
};

const FULL_RESEARCH_FINDINGS: ProspectResearch = {
  companySummary: "Sharma Retailers operates three stores in Noida and is actively hiring.",
  likelyNeeds: ["Inventory management software"],
  possiblePainPoints: ["Manual stock tracking"],
  relevantProductsOrServices: ["POS system"],
  buyingSignals: ["Actively hiring store staff", "Recently opened a third location"],
  personalizationOpportunities: ["Mention their Noida expansion"],
  potentialObjections: ["May already have a POS vendor"],
  confidence: "high",
  verifiedInformation: ["Company: Sharma Retailers", "Location: Noida", "Three store locations"],
  businessFactsReferenced: ["POS Package"],
  inferredInformation: ["Likely evaluating vendors given recent growth"],
  unavailableInformation: ["Current POS vendor, if any"],
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

  it("sends structured research findings — buying signals, objections, verified evidence, and confidence — as their own section, separate from Business Knowledge and the campaign ICP", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runLeadQualification({
      ...baseInput,
      icpCriteria: { targetMarket: "Retail store owners" },
      researchFindings: FULL_RESEARCH_FINDINGS,
    });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    const leadIdx = prompt.indexOf("=== LEAD ===");
    const researchIdx = prompt.indexOf("=== PROSPECT RESEARCH FINDINGS");
    const icpIdx = prompt.indexOf("=== CAMPAIGN ICP");

    // Three distinct, ordered sections — never merged into one another.
    expect(leadIdx).toBeGreaterThanOrEqual(0);
    expect(researchIdx).toBeGreaterThan(leadIdx);
    expect(icpIdx).toBeGreaterThan(researchIdx);

    // Buying signals reach the context.
    expect(prompt).toContain("Actively hiring store staff");
    expect(prompt.indexOf("Actively hiring store staff")).toBeGreaterThan(researchIdx);
    expect(prompt.indexOf("Actively hiring store staff")).toBeLessThan(icpIdx);
    // Objections reach the context.
    expect(prompt).toContain("May already have a POS vendor");
    // Verified evidence/source information reaches the context.
    expect(prompt).toContain("Three store locations");
    // Confidence/research status reaches the context.
    expect(prompt).toContain("Research confidence: high");
    // Missing information (what research could not determine) reaches the context.
    expect(prompt).toContain("Current POS vendor, if any");
    // Inferred content is present but explicitly labeled as not verified.
    expect(prompt).toContain("NOT independently verified");
    expect(prompt).toContain("Likely evaluating vendors given recent growth");
  });

  it("does not repeat Business Knowledge facts already referenced by research, or outreach-drafting fields not needed for scoring — keeps the research section to what actually bears on fit/intent", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runLeadQualification({ ...baseInput, researchFindings: FULL_RESEARCH_FINDINGS });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    // businessFactsReferenced, likelyNeeds, possiblePainPoints, relevantProductsOrServices,
    // and personalizationOpportunities are outreach/duplication-prone fields deliberately
    // left out of the research section (see formatResearchFindings's own comment).
    expect(prompt).not.toContain("POS Package");
    expect(prompt).not.toContain("Inventory management software");
    expect(prompt).not.toContain("Manual stock tracking");
    expect(prompt).not.toContain("Mention their Noida expansion");
  });

  it("falls back to an explicit 'no structured research findings' line when researchFindings is null — qualification still works from the summary alone", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    const result = await runLeadQualification({
      ...baseInput,
      researchSummary: "Sharma Retailers operates three stores in Noida.",
      researchFindings: null,
    });

    expect(result.ok).toBe(true);
    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("No structured research findings on file for this lead yet.");
    expect(prompt).toContain("Sharma Retailers operates three stores in Noida.");
  });

  it("treats structured findings with every array empty the same as no structured findings — none of the six lines silently disappear or throw", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    const emptyFindings: ProspectResearch = {
      companySummary: "",
      likelyNeeds: [],
      possiblePainPoints: [],
      relevantProductsOrServices: [],
      buyingSignals: [],
      personalizationOpportunities: [],
      potentialObjections: [],
      confidence: "low",
      verifiedInformation: [],
      businessFactsReferenced: [],
      inferredInformation: [],
      unavailableInformation: [],
    };

    const result = await runLeadQualification({ ...baseInput, researchFindings: emptyFindings });

    expect(result.ok).toBe(true);
    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("Buying signals: none recorded.");
    expect(prompt).toContain("Potential objections: none recorded.");
    expect(prompt).toContain("Verified facts about this prospect: none recorded.");
    expect(prompt).toContain("Research confidence: low");
  });

  it("forwards an explicit client straight through to runHermesCompletion — this is what lets a cron/scheduled call's own agent_runs/model_usage telemetry actually reach RLS-protected tables instead of silently falling back to the session-less default client", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const explicitClient = { from: vi.fn() } as never;

    await runLeadQualification({ ...baseInput, client: explicitClient });

    expect(vi.mocked(runHermesCompletion).mock.calls[0][0].client).toBe(explicitClient);
  });

  it("leaves client undefined when the caller doesn't pass one — a real user-session call keeps using runHermesCompletion's own default cookie-based client, unchanged", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runLeadQualification(baseInput);

    expect(vi.mocked(runHermesCompletion).mock.calls[0][0].client).toBeUndefined();
  });

  // STEP 2 (Nemotron routing fix): Qualification previously sent no
  // explicit model at all, silently inheriting whatever OPENROUTER_MODEL
  // happened to resolve to. It must now explicitly name Nemotron on
  // openrouter only — exactly like Lead Discovery's two Nemotron stages and
  // Research — so a fallback still requests Groq's own configured model,
  // never Nemotron's id.
  it("explicitly pins Nemotron on the openrouter provider only, never touching a genuine fallback's own model", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });

    await runLeadQualification(baseInput);

    const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
    expect(call.modelByProvider).toEqual({ openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    expect(call.model).toBeUndefined();
  });

  it("requests the reasoning effort Nemotron 3 Ultra's own published spec actually supports, not OpenRouterProvider's own default — the same fix already applied to Lead Discovery, needed to avoid this call silently reasoning at 'high' and risking a timeout", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_QUALIFICATION), provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });

    await runLeadQualification(baseInput);

    expect(vi.mocked(runHermesCompletion).mock.calls[0][0].reasoningEffort).toBe("medium");
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

  it("4. a model cannot bypass the no-research-evidence gate simply because structured findings are present — the gate keys on researchSummary alone, never on whether researchFindings is populated", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_QUALIFICATION, recommendedStatus: "qualified" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    // researchSummary is null/missing (no real research evidence on file),
    // but researchFindings is fully populated with buying signals and
    // "verified" claims the model itself produced in this same response —
    // none of that can substitute for the actual research-completed signal.
    const result = await runLeadQualification({
      ...baseInput,
      researchSummary: null,
      researchFindings: FULL_RESEARCH_FINDINGS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.qualification.recommendedStatus).toBe("qualifying");
    expect(result.qualification.missingInformation).toEqual(expect.arrayContaining([expect.stringContaining("Lead Research")]));
  });

  it("5. research findings alone (without a research summary) also cannot produce a final 'disqualified' decision", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_QUALIFICATION, recommendedStatus: "disqualified" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification({
      ...baseInput,
      researchSummary: null,
      researchFindings: FULL_RESEARCH_FINDINGS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.qualification.recommendedStatus).toBe("qualifying");
  });
});
