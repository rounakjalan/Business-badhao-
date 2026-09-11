import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessContext } from "@/lib/business-context";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runProspectResearch, type DiscoveryEvidence } from "@/lib/ai/agents/prospect-research";

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
  discoveryEvidence: null,
};

const REAL_DISCOVERY_EVIDENCE: DiscoveryEvidence = {
  location: "Jaipur",
  industry: "Retail",
  businessType: "Boutique",
  matchedIcpCriteria: ["location: Jaipur"],
  evidenceSnippet: "Sharma Retailers is a family-run clothing store in Jaipur serving customers since 2010.",
  sourceUrl: "https://directory.example/jaipur-retail",
  hasVerifiedContact: true,
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

  it("feeds the real discovery evidence (the search excerpt, source, ICP match) into the actual request when it's on file — this is what gives research something concrete to verify against instead of reasoning almost blind", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_RESEARCH), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runProspectResearch({ ...baseInput, discoveryEvidence: REAL_DISCOVERY_EVIDENCE });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("Sharma Retailers is a family-run clothing store in Jaipur serving customers since 2010.");
    expect(prompt).toContain("https://directory.example/jaipur-retail");
    expect(prompt).toContain("location: Jaipur");
  });

  it("honestly tells the model there is no discovery evidence for a lead added without it, rather than silently omitting the section", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_RESEARCH), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runProspectResearch({ ...baseInput, discoveryEvidence: null });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("No discovery evidence on file for this lead");
  });

  it("forwards an explicit client straight through to runHermesCompletion — this is what lets a cron/scheduled call's own agent_runs/model_usage telemetry actually reach RLS-protected tables instead of silently falling back to the session-less default client", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_RESEARCH), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const explicitClient = { from: vi.fn() } as never;

    await runProspectResearch({ ...baseInput, client: explicitClient });

    expect(vi.mocked(runHermesCompletion).mock.calls[0][0].client).toBe(explicitClient);
  });

  it("leaves client undefined when the caller doesn't pass one — a real user-session call keeps using runHermesCompletion's own default cookie-based client, unchanged", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_RESEARCH), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await runProspectResearch(baseInput);

    expect(vi.mocked(runHermesCompletion).mock.calls[0][0].client).toBeUndefined();
  });

  // STEP 2 (Nemotron routing fix): Research previously sent no explicit
  // model at all, silently inheriting whatever OPENROUTER_MODEL happened to
  // resolve to. It must now explicitly name Nemotron on openrouter only —
  // exactly like Lead Discovery's two Nemotron stages — so a fallback still
  // requests Groq's own configured model, never Nemotron's id.
  it("explicitly pins Nemotron on the openrouter provider only, never touching a genuine fallback's own model", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_RESEARCH), provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });

    await runProspectResearch(baseInput);

    const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
    expect(call.modelByProvider).toEqual({ openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    // No blanket `model` override — that would also get sent to a
    // fallback provider that has no such model id (see modelByProvider's
    // own doc comment in hermes-service.ts).
    expect(call.model).toBeUndefined();
  });

  it("requests the reasoning effort Nemotron 3 Ultra's own published spec actually supports, not OpenRouterProvider's own default — the same fix already applied to Lead Discovery, needed to avoid this call silently reasoning at 'high' and risking a timeout", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_RESEARCH), provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });

    await runProspectResearch(baseInput);

    expect(vi.mocked(runHermesCompletion).mock.calls[0][0].reasoningEffort).toBe("medium");
  });
});
