import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";

export const OutreachDraftSchema = z.object({
  subject: z.string().nullable(),
  message: z.string(),
  talkingPoints: z.array(z.string()),
  personalizationUsed: z.array(z.string()),
});

export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;

export type OutreachGeneratorInput = {
  organizationId: string;
  leadName: string;
  companyName: string | null;
  channel: string;
  campaignName: string | null;
  campaignObjective: string | null;
  researchSummary: string | null;
  qualificationReasons: string[];
  /** The campaign's saved ICP (ideal_customer_profiles.criteria) — null when the campaign has none. */
  icpCriteria: Record<string, unknown> | null;
  /** This organization's relevant Business Knowledge (see selectOutreachContext in src/lib/business-context.ts) — null when none is on file. */
  businessContext: BusinessContext | null;
};

export type OutreachGeneratorResult =
  | { ok: true; draft: OutreachDraft }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI outreach writer inside Business Badhao, a customer-acquisition CRM. Draft ONE personalized outreach message for a specific lead and channel, grounded only in the information given: this business's real Business Knowledge (profile, products/services, value proposition, FAQs as approved claims, brand voice/communication rules, relevant assets) and the lead/campaign details below it, including the campaign's target customer profile (ICP) when one is given — use it to inform tone and emphasis, never as a fact about this specific lead.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "subject": string | null,
  "message": string,
  "talkingPoints": string[],
  "personalizationUsed": string[]
}

"subject" is only used for email — set it to null for chat-style channels (whatsapp, sms, instagram, linkedin, phone, web_chat). "personalizationUsed" must list which specific pieces of the given input the message actually references. Follow BUSINESS KNOWLEDGE's communication rules (brand voice, formality, must-never-claim) if given. Never invent a product, price, guarantee, testimonial, policy, or business claim not present in BUSINESS KNOWLEDGE, and never fabricate a personal detail or statistic about the lead either — if little is known, write a shorter, more general (but still non-spammy) message and say so implicitly by keeping personalizationUsed minimal.`;

/**
 * Generates a personalized outreach draft only — this never sends
 * anything. Sending requires a real channel integration (WhatsApp/email/
 * etc.), which Business Badhao doesn't have yet; the draft is meant to be
 * reviewed and sent by a human through whatever channel is available today.
 */
export async function generateOutreach(input: OutreachGeneratorInput): Promise<OutreachGeneratorResult> {
  const businessKnowledgeText = input.businessContext ? formatBusinessContext(input.businessContext) : null;

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (authoritative — see system prompt) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    "",
    "=== LEAD / CAMPAIGN ===",
    `Lead name: ${input.leadName}`,
    `Company: ${input.companyName ?? "unknown"}`,
    `Channel: ${input.channel}`,
    `Campaign: ${input.campaignName ?? "none"}`,
    `Campaign objective: ${input.campaignObjective ?? "unknown"}`,
    `Target customer profile (ICP) for this campaign: ${input.icpCriteria ? JSON.stringify(input.icpCriteria) : "none on file"}`,
    `Research on file: ${input.researchSummary ?? "none"}`,
    `Qualification notes: ${input.qualificationReasons.length > 0 ? input.qualificationReasons.join("; ") : "none"}`,
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "outreach_generation",
    taskType: "OUTREACH_GENERATION",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    // 500 was too small: unlike qualification/follow-up/intent, this
    // schema's "message" field is a full free-text email body, not a short
    // structured field, plus reasoning-model overhead on top. Real
    // production failures (agent_runs, task 2026-08-26) showed Groq
    // rejecting the request outright with json_validate_failed / "max
    // completion tokens reached before generating a valid document" —
    // the same failure class prospect-research.ts and qualification.ts
    // already hit and fixed by matching this same 1600 ceiling.
    maxTokens: 1600,
    temperature: 0.7,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, OutreachDraftSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI outreach draft couldn't be validated — please try again." };
  }

  return { ok: true, draft: parsed.data };
}
