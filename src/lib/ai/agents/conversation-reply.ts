import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";

export const ConversationReplySchema = z.object({
  message: z.string(),
  /** Advisory only — surfaced to a human in the UI, never acted on automatically. This agent has no ability to take over, close a deal, or notify anyone by itself. */
  recommendHandoff: z.boolean(),
  handoffReason: z.string().nullable(),
});

export type ConversationReply = z.infer<typeof ConversationReplySchema>;

export type ConversationReplyInput = {
  organizationId: string;
  leadName: string;
  channel: string;
  campaignName: string | null;
  /** The three-level classification already computed for this turn (see mapIntentToBuyingIntent) — informs tone, not a fact to restate to the customer. */
  buyingIntent: "low" | "medium" | "high" | null;
  messages: { direction: string; senderType: string; body: string }[];
  /** This organization's relevant Business Knowledge (see selectConversationContext in src/lib/business-context.ts) — null when none is on file. */
  businessContext: BusinessContext | null;
};

export type ConversationReplyResult = { ok: true; reply: ConversationReply } | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI conversation agent inside Business Badhao, a customer-acquisition CRM. You are replying to a real lead, continuing a real conversation thread, on behalf of this business. Ground every claim only in this business's real Business Knowledge (profile, products/services, value proposition, FAQs as approved answers, policies, brand voice/communication rules) and what the lead has actually said in this thread — never invent a product, price, feature, guarantee, policy, or personal detail not present in either.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "message": string,
  "recommendHandoff": boolean,
  "handoffReason": string | null
}

CRITICAL — you have no ability to check or confirm payments, and no visibility into whether any deal has actually closed. Regardless of what the lead says ("I've paid", "I'll buy it", "sending payment now"), NEVER claim in "message" that a payment was received, an order was confirmed, a purchase was completed, or a deal was won — you cannot know that, and only a human confirming an actual payment makes it true. If the lead indicates they are ready to buy or pay, say a team member will follow up to complete that with them, and set "recommendHandoff" to true.

Set "recommendHandoff" to true whenever a human should step in instead of you continuing to reply — strong buying signals, a request to speak to a person, a question you cannot honestly answer from the given Business Knowledge, price negotiation, or anything you are not confident about. This is advisory only; you are never taking over or closing anything yourself. Set "handoffReason" to a short reason when true, null when false.

Follow BUSINESS KNOWLEDGE's communication rules (brand voice, formality, must-never-claim) if given. If little relevant Business Knowledge is available for what the lead asked, say so honestly and offer to have someone follow up — never fabricate an answer.`;

/**
 * Generates the next reply in an ongoing conversation — the piece Phase 5's
 * outreach generator doesn't cover (that only ever drafts the first
 * message). Used by the shared orchestration (src/lib/conversation-agent)
 * for both the Gmail reply-poll path and the WhatsApp webhook path, only
 * when the conversation is still AI-owned. Never sends anything itself.
 */
export async function generateConversationReply(input: ConversationReplyInput): Promise<ConversationReplyResult> {
  const businessKnowledgeText = input.businessContext ? formatBusinessContext(input.businessContext) : null;
  const thread = input.messages.map((m) => `[${m.direction === "inbound" ? "Lead" : m.senderType}]: ${m.body}`).join("\n");

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (authoritative — see system prompt) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    "",
    "=== CONVERSATION ===",
    `Lead name: ${input.leadName}`,
    `Channel: ${input.channel}`,
    `Campaign: ${input.campaignName ?? "none"}`,
    `Current buying intent: ${input.buyingIntent ?? "not yet assessed"}`,
    "",
    "Conversation so far (reply to the lead's most recent message):",
    thread || "(no messages yet)",
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "conversation_reply",
    taskType: "CONVERSATION",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1600,
    temperature: 0.6,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, ConversationReplySchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI conversation reply couldn't be validated — please try again." };
  }

  return { ok: true, reply: parsed.data };
}
