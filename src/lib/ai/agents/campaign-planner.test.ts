import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runCampaignPlanner } from "@/lib/ai/agents/campaign-planner";

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

    expect(result).toEqual({ ok: true, plan: VALID_PLAN });
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
});
