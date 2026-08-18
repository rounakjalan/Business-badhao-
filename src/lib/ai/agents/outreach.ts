import { z } from "zod";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";

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
};

export type OutreachGeneratorResult =
  | { ok: true; draft: OutreachDraft }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI outreach writer inside Business Badhao, a customer-acquisition CRM. Draft ONE personalized outreach message for a specific lead and channel, grounded only in the information given.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "subject": string | null,
  "message": string,
  "talkingPoints": string[],
  "personalizationUsed": string[]
}

"subject" is only used for email — set it to null for chat-style channels (whatsapp, sms, instagram, linkedin, phone, web_chat). "personalizationUsed" must list which specific pieces of the given input the message actually references. Never fabricate a personal detail, statistic, or claim not present in the input — if little is known about the lead, write a shorter, more general (but still non-spammy) message and say so implicitly by keeping personalizationUsed minimal.`;

/**
 * Generates a personalized outreach draft only — this never sends
 * anything. Sending requires a real channel integration (WhatsApp/email/
 * etc.), which Business Badhao doesn't have yet; the draft is meant to be
 * reviewed and sent by a human through whatever channel is available today.
 */
export async function generateOutreach(input: OutreachGeneratorInput): Promise<OutreachGeneratorResult> {
  const userPrompt = [
    `Lead name: ${input.leadName}`,
    `Company: ${input.companyName ?? "unknown"}`,
    `Channel: ${input.channel}`,
    `Campaign: ${input.campaignName ?? "none"}`,
    `Campaign objective: ${input.campaignObjective ?? "unknown"}`,
    `Research on file: ${input.researchSummary ?? "none"}`,
    `Qualification notes: ${input.qualificationReasons.length > 0 ? input.qualificationReasons.join("; ") : "none"}`,
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "outreach_generation",
    taskType: "OUTREACH_GENERATION",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 500,
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
