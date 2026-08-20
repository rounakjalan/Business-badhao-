import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";

export const FollowUpPlanSchema = z.object({
  followUpTiming: z.string(),
  followUpMessage: z.string(),
  educationalContentSuggestion: z.string().nullable(),
  objectionHandling: z.array(z.string()),
  nurtureStatus: z.enum(["nurture_soon", "nurture_later", "monitor"]),
});

export type FollowUpPlan = z.infer<typeof FollowUpPlanSchema>;

export type FollowUpInput = {
  organizationId: string;
  leadName: string;
  channel: string;
  detectedIntent: string | null;
  messages: { direction: string; senderType: string; body: string }[];
  /** This organization's relevant Business Knowledge (see selectFollowUpContext in src/lib/business-context.ts) — null when none is on file. */
  businessContext: BusinessContext | null;
};

export type FollowUpResult = { ok: true; plan: FollowUpPlan } | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI follow-up agent inside Business Badhao, a customer-acquisition CRM, for leads who are not yet ready to buy. Given the conversation so far and this business's real Business Knowledge (products/services, FAQs, relevant policies, communication rules), propose ONE follow-up plan — never suggest anything that reads as spam or pressures the lead.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "followUpTiming": string (a human-readable timing recommendation, e.g. "in 3-4 days" — do not output a specific calendar date, you don't know today's date),
  "followUpMessage": string,
  "educationalContentSuggestion": string | null,
  "objectionHandling": string[],
  "nurtureStatus": "nurture_soon" | "nurture_later" | "monitor"
}

Ground the message and objection handling in what the lead actually said, plus this business's real Business Knowledge — if the lead asked a question or raised an objection that BUSINESS KNOWLEDGE's FAQs or policies actually answer, use that real answer. Never invent a product, price, policy, or business fact not present in BUSINESS KNOWLEDGE. If they raised no objections, return an empty array rather than inventing one.`;

/**
 * Produces a follow-up plan for a lead who isn't ready to buy yet. Creates
 * a real task for a human to act on (see leads/actions.ts and
 * conversations/actions.ts callers) — never sends anything itself.
 */
export async function runFollowUp(input: FollowUpInput): Promise<FollowUpResult> {
  const businessKnowledgeText = input.businessContext ? formatBusinessContext(input.businessContext) : null;
  const thread = input.messages.map((m) => `[${m.direction === "inbound" ? "Lead" : m.senderType}]: ${m.body}`).join("\n");

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (authoritative — see system prompt) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    "",
    "=== CONVERSATION ===",
    `Lead name: ${input.leadName}`,
    `Channel: ${input.channel}`,
    `Detected intent: ${input.detectedIntent ?? "not yet detected"}`,
    "",
    "Conversation:",
    thread || "(no messages yet)",
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "follow_up",
    taskType: "FOLLOW_UP",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 500,
    temperature: 0.5,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, FollowUpPlanSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI follow-up plan couldn't be validated — please try again." };
  }

  return { ok: true, plan: parsed.data };
}
