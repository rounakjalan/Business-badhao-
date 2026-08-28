import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";

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
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  rootCause: z.string(),
  /** Customer objections/concerns actually raised in the conversation. */
  objections: z.array(z.string()),
  pricingConcerns: z.array(z.string()),
  productFitConcerns: z.array(z.string()),
  timingConcerns: z.array(z.string()),
  /** Competitors actually named in the conversation — never invented. */
  competitorMentions: z.array(z.string()),
  communicationIssues: z.array(z.string()),
  /** Short verbatim or close-paraphrase excerpts from the conversation backing the analysis above. */
  supportingEvidence: z.array(z.string()),
  /** The specific product/service the conversation was actually about, if any — same extraction the deal agent does for open deals. */
  productOrServiceInvolved: z.string().nullable(),
  recoveryOpportunity: z.object({
    justified: z.boolean(),
    reasoning: z.string(),
    suggestedApproach: z.string().nullable(),
  }),
  lessons: z.array(z.string()),
  recommendedCampaignChanges: z.array(z.string()),
  recommendedIcpChanges: z.array(z.string()),
  recommendedOutreachChanges: z.array(z.string()),
});

export type LossAnalysis = z.infer<typeof LossAnalysisSchema>;

export type BuyingIntentSnapshot = { at: string; buyingIntent: "low" | "medium" | "high" };

export type LossAnalysisInput = {
  organizationId: string;
  dealTitle: string;
  value: number;
  currency: string;
  humanSelectedReason: string | null;
  leadName: string;
  campaignObjective: string | null;
  messages: { direction: string; senderType: string; body: string }[];
  /** Real, already-computed intent history for this deal's conversation — never inferred by the model. Empty when intent was never detected. */
  buyingIntentHistory: BuyingIntentSnapshot[];
  /** The conversation's/lead's current buying_intent at the time the deal was lost. */
  currentBuyingIntent: "low" | "medium" | "high" | null;
  /** This organization's relevant Business Knowledge (see selectLossAnalysisContext in src/lib/business-context.ts) — null when none is on file. */
  businessContext: BusinessContext | null;
};

export type LossAnalysisResult = { ok: true; analysis: LossAnalysis } | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI loss-analysis agent inside Business Badhao, a customer-acquisition CRM. A deal was just marked lost. Analyze why, using the deal record, real conversation, the lead's real recorded buying-intent history, and this business's real Business Knowledge (products/services with real pricing, relevant policies) given, and recommend concrete changes.

You must ground every field in the actual data given — the conversation, the deal record, the recorded buying-intent history, or Business Knowledge. Never invent a customer objection, a competitor name, a price, a policy, or a quote that isn't actually present in what you were given. If a category (objections, pricing concerns, competitor mentions, etc.) has no real evidence in the conversation, return an empty array for it rather than guessing — an empty array is a correct, honest answer. "supportingEvidence" must be short verbatim or very close paraphrases of things actually said in the conversation, not summaries you invented.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "primaryReason": "price" | "competitor" | "timing" | "product_mismatch" | "poor_fit" | "lack_of_trust" | "no_response" | "requirements_mismatch" | "other",
  "secondaryReasons": (same enum)[],
  "confidence": "low" | "medium" | "high",
  "summary": string,
  "rootCause": string,
  "objections": string[],
  "pricingConcerns": string[],
  "productFitConcerns": string[],
  "timingConcerns": string[],
  "competitorMentions": string[],
  "communicationIssues": string[],
  "supportingEvidence": string[],
  "productOrServiceInvolved": string | null,
  "recoveryOpportunity": { "justified": boolean, "reasoning": string, "suggestedApproach": string | null },
  "lessons": string[],
  "recommendedCampaignChanges": string[],
  "recommendedIcpChanges": string[],
  "recommendedOutreachChanges": string[]
}

Set "confidence" honestly based on how much real evidence you have — a one-message conversation with no reply deserves "low" confidence, not a confident-sounding guess. recoveryOpportunity.justified should only be true when the conversation or record gives a real reason to believe re-engagement could work (e.g. an unresolved objection that could be addressed, a stated future timing, price sensitivity that a different offer could solve) — if the lead went cold with no signal, or was clearly a poor fit, set it to false and say why in "reasoning" rather than suggesting an approach with no evidence behind it. If the human already picked a reason category, treat it as a strong signal but still reason from the actual conversation and Business Knowledge — they may not always agree. Never invent a price, policy, or business fact not present in Business Knowledge when explaining the loss. If there's little conversation to go on, say so in "summary" and keep recommendations general rather than fabricating specifics.`;

/**
 * Analyzes a lost deal's real record, conversation, recorded buying-intent
 * history, and this business's real Business Knowledge, and produces a
 * structured post-mortem. Called after markDealLost() (deals/actions.ts)
 * has already recorded the human-chosen reason category; this updates that
 * same loss_analysis row with the AI's fuller analysis rather than
 * inserting a duplicate.
 */
export async function runLossAnalysis(input: LossAnalysisInput): Promise<LossAnalysisResult> {
  const businessKnowledgeText = input.businessContext ? formatBusinessContext(input.businessContext) : null;
  const thread = input.messages.map((m) => `[${m.direction === "inbound" ? "Lead" : m.senderType}]: ${m.body}`).join("\n");
  const intentHistoryText =
    input.buyingIntentHistory.length > 0
      ? input.buyingIntentHistory.map((s) => `${s.at}: ${s.buyingIntent}`).join("\n")
      : "(buying intent was never detected for this conversation)";

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (authoritative — see system prompt) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    "",
    "=== DEAL ===",
    `Deal: ${input.dealTitle}`,
    `Value: ${input.value} ${input.currency}`,
    `Lead: ${input.leadName}`,
    `Campaign objective: ${input.campaignObjective ?? "unknown"}`,
    `Human-selected loss reason: ${input.humanSelectedReason ?? "not specified"}`,
    "",
    "=== RECORDED BUYING-INTENT HISTORY (real, not inferred here) ===",
    intentHistoryText,
    `Final buying intent before loss: ${input.currentBuyingIntent ?? "never assessed"}`,
    "",
    "Conversation:",
    thread || "(no conversation on file)",
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "loss_analysis",
    taskType: "LOSS_ANALYSIS",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1600,
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
