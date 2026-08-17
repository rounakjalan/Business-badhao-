import { z } from "zod";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";

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
};

export type FollowUpResult = { ok: true; plan: FollowUpPlan } | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI follow-up agent inside Business Badhao, a customer-acquisition CRM, for leads who are not yet ready to buy. Given the conversation so far, propose ONE follow-up plan — never suggest anything that reads as spam or pressures the lead.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "followUpTiming": string (a human-readable timing recommendation, e.g. "in 3-4 days" — do not output a specific calendar date, you don't know today's date),
  "followUpMessage": string,
  "educationalContentSuggestion": string | null,
  "objectionHandling": string[],
  "nurtureStatus": "nurture_soon" | "nurture_later" | "monitor"
}

Ground the message and objection handling in what the lead actually said. If they raised no objections, return an empty array rather than inventing one.`;

/**
 * Produces a follow-up plan for a lead who isn't ready to buy yet. Creates
 * a real task for a human to act on (see leads/actions.ts and
 * conversations/actions.ts callers) — never sends anything itself.
 */
export async function runFollowUp(input: FollowUpInput): Promise<FollowUpResult> {
  const thread = input.messages.map((m) => `[${m.direction === "inbound" ? "Lead" : m.senderType}]: ${m.body}`).join("\n");

  const userPrompt = [
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
