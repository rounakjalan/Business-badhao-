import { afterEach, describe, expect, it, vi } from "vitest";

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
});
