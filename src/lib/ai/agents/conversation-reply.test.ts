import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { generateConversationReply, ConversationReplySchema } from "@/lib/ai/agents/conversation-reply";

const VALID_REPLY = {
  message: "Thanks for asking! Our Home Theatre Installation package includes a 2-year warranty. Happy to share more details.",
  recommendHandoff: false,
  handoffReason: null,
};

const baseInput = {
  organizationId: "org-1",
  leadName: "Priya Sharma",
  channel: "email",
  campaignName: "Q3 Push",
  buyingIntent: "medium" as const,
  messages: [{ direction: "inbound", senderType: "lead", body: "Does the installation come with a warranty?" }],
  businessContext: null,
};

describe("generateConversationReply", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated reply on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_REPLY), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await generateConversationReply(baseInput);
    expect(result).toEqual({ ok: true, reply: VALID_REPLY });
  });

  it("rejects a response missing the required message field", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify({ recommendHandoff: false, handoffReason: null }), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await generateConversationReply(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "not_configured", message: "The AI assistant isn't connected yet." });
    const result = await generateConversationReply(baseInput);
    expect(result.ok).toBe(false);
  });

  it("does not fail when there is no business context", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_REPLY), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await generateConversationReply({ ...baseInput, businessContext: null });
    expect(result.ok).toBe(true);
  });

  it("does not fail when buyingIntent has not been assessed yet", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_REPLY), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await generateConversationReply({ ...baseInput, buyingIntent: null });
    expect(result.ok).toBe(true);
  });

  it("accepts a reply that recommends handoff with a reason", async () => {
    const handoffReply = { message: "I'll have someone from our team reach out to finalize this with you.", recommendHandoff: true, handoffReason: "Lead said they are ready to pay." };
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(handoffReply), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    const result = await generateConversationReply(baseInput);
    expect(result).toEqual({ ok: true, reply: handoffReply });
  });

  it("includes the system prompt's explicit ban on claiming payment/deal-closure in the actual Hermes request", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_REPLY), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    await generateConversationReply(baseInput);

    const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
    expect(call.systemPrompt).toContain("NEVER claim");
    expect(call.systemPrompt.toLowerCase()).toContain("payment");
    expect(call.systemPrompt.toLowerCase()).toContain("deal was won");
    expect(call.taskType).toBe("CONVERSATION");
  });

  it("includes real Business Knowledge, campaign, and buying intent in the actual Hermes request", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_REPLY), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

    await generateConversationReply({
      ...baseInput,
      businessContext: {
        businessProfile: null,
        productsServices: [{ name: "Home Theatre Installation", description: null, category: null, price: 45000, pricingType: "fixed", features: [], benefits: [], availability: "available", specialOffers: null }],
        valueProposition: { keySellingPoints: [], productBenefits: [] },
        faqs: [{ question: "Do you offer a warranty?", answer: "Yes, 2 years on all installations.", category: null }],
        policies: [],
        aiCommunicationRules: null,
        mediaReferences: [],
      },
    });

    const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
    expect(prompt).toContain("Home Theatre Installation");
    expect(prompt).toContain("Yes, 2 years on all installations.");
    expect(prompt).toContain("Q3 Push");
    expect(prompt).toContain("medium");
  });

  it("has no field the AI could use to claim/signal a deal being won or a payment being received — recommendHandoff is advisory only, never an execution channel", () => {
    const keys = Object.keys(ConversationReplySchema.shape);
    expect(keys).toEqual(["message", "recommendHandoff", "handoffReason"]);
    expect(keys.some((k) => /deal|paid|payment|won|purchase|order/i.test(k))).toBe(false);
  });

  it("never enables tool-calling — this agent cannot invoke any function, including the read-only lookup tools, let alone mutate a deal", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: true, text: JSON.stringify(VALID_REPLY), provider: "openrouter", model: "nousresearch/hermes-4-70b" });
    await generateConversationReply(baseInput);
    const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
    expect(call.enableTools).toBeFalsy();
  });
});
