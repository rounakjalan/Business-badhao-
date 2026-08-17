import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runDealAgent } from "@/lib/ai/agents/deal-agent";

const VALID_RECOMMENDATION = {
  negotiationState: "Price agreed, awaiting PO",
  requirements: ["needs invoice before payment"],
  requestedProductOrService: "Standard plan",
  priceDiscussionSummary: "Agreed on listed price",
  objections: [],
  decisionMakerStatus: "confirmed_decision_maker",
  closingReadiness: "high",
  recommendedNextAction: "Send the invoice",
};

const baseInput = {
  organizationId: "org-1",
  dealTitle: "Acme <> Retailer X",
  value: 45000,
  currency: "INR",
  status: "negotiation",
  leadName: "Rohit Verma",
  channel: "whatsapp",
  messages: [{ direction: "inbound", senderType: "lead", body: "Sounds good, send the invoice." }],
};

describe("runDealAgent", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated recommendation on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_RECOMMENDATION),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runDealAgent(baseInput);
    expect(result).toEqual({ ok: true, recommendation: VALID_RECOMMENDATION });
  });

  it("rejects an invalid decisionMakerStatus", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_RECOMMENDATION, decisionMakerStatus: "maybe" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runDealAgent(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "invalid_api_key", message: "The AI provider rejected the configured credentials." });
    const result = await runDealAgent(baseInput);
    expect(result.ok).toBe(false);
  });
});
