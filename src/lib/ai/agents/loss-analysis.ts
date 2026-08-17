import { z } from "zod";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";

export const LOSS_ROOT_CAUSES = [
  "price",
  "competitor",
  "timing",
  "product_mismatch",
  "poor_fit",
  "lack_of_trust",
  "no_response",
  "requirements_mismatch",
  "other",
] as const;

export const LossAnalysisSchema = z.object({
  primaryReason: z.enum(LOSS_ROOT_CAUSES),
  secondaryReasons: z.array(z.enum(LOSS_ROOT_CAUSES)),
  summary: z.string(),
  rootCause: z.string(),
  lessons: z.array(z.string()),
  recommendedCampaignChanges: z.array(z.string()),
  recommendedIcpChanges: z.array(z.string()),
  recommendedOutreachChanges: z.array(z.string()),
});

export type LossAnalysis = z.infer<typeof LossAnalysisSchema>;

export type LossAnalysisInput = {
  organizationId: string;
  dealTitle: string;
  value: number;
  currency: string;
  humanSelectedReason: string | null;
  leadName: string;
  campaignObjective: string | null;
  messages: { direction: string; senderType: string; body: string }[];
};

export type LossAnalysisResult = { ok: true; analysis: LossAnalysis } | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI loss-analysis agent inside Business Badhao, a customer-acquisition CRM. A deal was just marked lost. Analyze why, using the deal record and conversation given, and recommend concrete changes.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "primaryReason": "price" | "competitor" | "timing" | "product_mismatch" | "poor_fit" | "lack_of_trust" | "no_response" | "requirements_mismatch" | "other",
  "secondaryReasons": (same enum)[],
  "summary": string,
  "rootCause": string,
  "lessons": string[],
  "recommendedCampaignChanges": string[],
  "recommendedIcpChanges": string[],
  "recommendedOutreachChanges": string[]
}

If the human already picked a reason category, treat it as a strong signal but still reason from the actual conversation — they may not always agree. If there's little conversation to go on, say so in "summary" and keep recommendations general rather than fabricating specifics.`;

/**
 * Analyzes a lost deal's real record + conversation and produces a
 * structured post-mortem. Called after markDealLost() (deals/actions.ts)
 * has already recorded the human-chosen reason category; this updates
 * that same loss_analysis row with the AI's fuller analysis rather than
 * inserting a duplicate.
 */
export async function runLossAnalysis(input: LossAnalysisInput): Promise<LossAnalysisResult> {
  const thread = input.messages.map((m) => `[${m.direction === "inbound" ? "Lead" : m.senderType}]: ${m.body}`).join("\n");

  const userPrompt = [
    `Deal: ${input.dealTitle}`,
    `Value: ${input.value} ${input.currency}`,
    `Lead: ${input.leadName}`,
    `Campaign objective: ${input.campaignObjective ?? "unknown"}`,
    `Human-selected loss reason: ${input.humanSelectedReason ?? "not specified"}`,
    "",
    "Conversation:",
    thread || "(no conversation on file)",
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "loss_analysis",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 700,
    temperature: 0.4,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, LossAnalysisSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI loss analysis couldn't be validated — please try again." };
  }

  return { ok: true, analysis: parsed.data };
}
