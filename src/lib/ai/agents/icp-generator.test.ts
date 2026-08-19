import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runIcpGenerator } from "@/lib/ai/agents/icp-generator";
import type { CampaignPlan } from "@/lib/ai/agents/campaign-planner";

const VALID_PLAN: CampaignPlan = {
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

const VALID_ICP = {
  targetCustomer: "Independent electronics retail shop owners",
  ageRange: "30-55",
  location: "Delhi NCR",
  industry: "Retail electronics",
  businessType: "Single-location physical store",
  budgetRange: "₹5,000-₹20,000/month marketing spend",
  needs: ["More foot traffic", "Online visibility"],
  painPoints: ["Low foot traffic", "Competing with e-commerce"],
  buyingSignals: ["Asked about pricing", "Visited store website"],
  decisionFactors: ["Price", "Proven local results"],
  disqualifiers: ["No physical store", "Outside NCR"],
  preferredChannels: ["WhatsApp", "Instagram"],
  qualificationCriteria: ["Has a physical store", "In NCR"],
};

const baseInput = {
  organizationId: "org-1",
  organizationName: "Acme",
  campaignName: "Q1 Push",
  objective: "Get more customers",
  description: "",
  plan: VALID_PLAN,
};

describe("runIcpGenerator", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated ICP on success, grounded in the plan", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_ICP),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runIcpGenerator(baseInput);

    expect(result).toEqual({ ok: true, icp: VALID_ICP });
    const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
    expect(call).toEqual(
      expect.objectContaining({ organizationId: "org-1", agentType: "icp_generator", taskType: "ICP_GENERATION", responseFormat: "json" })
    );
    expect(call.userPrompt).toContain("Retail store owners"); // plan.targetMarket made it into the prompt
    expect(call.userPrompt).toContain("Reach more customers online"); // plan.valueProposition made it into the prompt
  });

  it("accepts null for fields that genuinely don't apply to a business", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_ICP, ageRange: null, businessType: null, budgetRange: null }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runIcpGenerator(baseInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.icp.ageRange).toBeNull();
      expect(result.icp.businessType).toBeNull();
      expect(result.icp.budgetRange).toBeNull();
    }
  });

  it("propagates a Hermes-level failure without pretending to have an ICP", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "not_configured", message: "The AI assistant isn't connected yet." });

    const result = await runIcpGenerator(baseInput);

    expect(result).toEqual({ ok: false, message: "The AI assistant isn't connected yet." });
  });

  it("rejects a response missing required fields rather than saving partial/invalid data", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ targetCustomer: "Someone" }), // missing everything else
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runIcpGenerator(baseInput);

    expect(result.ok).toBe(false);
  });

  it("rejects a response that isn't JSON at all", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: "Sure! Here's your ideal customer.",
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runIcpGenerator(baseInput);

    expect(result.ok).toBe(false);
  });
});
