import { z } from "zod";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";

export const INTENT_CATEGORIES = [
  "LOW_INTENT",
  "CURIOUS",
  "INFORMATION_REQUEST",
  "PRICE_REQUEST",
  "OBJECTION",
  "QUALIFYING",
  "HIGH_INTENT",
  "READY_TO_BUY",
  "NOT_INTERESTED",
  "UNCLEAR",
] as const;

export type IntentCategory = (typeof INTENT_CATEGORIES)[number];

export const HIGH_INTENT_CATEGORIES: ReadonlySet<IntentCategory> = new Set(["HIGH_INTENT", "READY_TO_BUY"]);

export const IntentAnalysisSchema = z.object({
  intent: z.enum(INTENT_CATEGORIES),
  confidence: z.enum(["low", "medium", "high"]),
  reasoning: z.string(),
  detectedObjections: z.array(z.string()),
  detectedBuyingSignals: z.array(z.string()),
  recommendedNextAction: z.string(),
});

export type IntentAnalysis = z.infer<typeof IntentAnalysisSchema>;

export type IntentDetectionInput = {
  organizationId: string;
  leadName: string;
  channel: string;
  messages: { direction: string; senderType: string; body: string }[];
  /**
   * Deliberately minimal — just what's offered (see
   * selectIntentProductNames in src/lib/business-context.ts), not a full
   * BusinessContext. Intent classification only needs enough to recognize
   * "the Home Theatre package" as product interest; FAQs/policies/brand
   * voice are irrelevant here and would only add cost/latency to a task
   * that's intentionally routed to a fast model.
   */
  productNames: string[];
};

export type IntentDetectionResult =
  | { ok: true; analysis: IntentAnalysis }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI conversation-intelligence agent inside Business Badhao, a customer-acquisition CRM. You are given a message thread between a business and a lead, and a short list of what the business offers (for recognizing product-interest signals only — treat it as a name list, not a source of prices/policies/claims). Analyze the lead's most recent messages in the context of the whole thread.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "intent": "LOW_INTENT" | "CURIOUS" | "INFORMATION_REQUEST" | "PRICE_REQUEST" | "OBJECTION" | "QUALIFYING" | "HIGH_INTENT" | "READY_TO_BUY" | "NOT_INTERESTED" | "UNCLEAR",
  "confidence": "low" | "medium" | "high",
  "reasoning": string,
  "detectedObjections": string[],
  "detectedBuyingSignals": string[],
  "recommendedNextAction": string
}

Base every field only on what's actually in the conversation. If the thread is too short or ambiguous to tell, use "UNCLEAR" with confidence "low" rather than guessing.`;

/**
 * Analyzes a real conversation's message history and classifies the lead's
 * current intent. Maintains context by being given the full thread each
 * time (Hermes/providers are stateless per call), not by any hidden
 * server-side session.
 */
export async function detectIntent(input: IntentDetectionInput): Promise<IntentDetectionResult> {
  const thread = input.messages
    .map((m) => `[${m.direction === "inbound" ? "Lead" : m.senderType}]: ${m.body}`)
    .join("\n");

  const userPrompt = [
    `Lead name: ${input.leadName}`,
    `Channel: ${input.channel}`,
    `Products/services offered: ${input.productNames.length > 0 ? input.productNames.join(", ") : "not on file"}`,
    "",
    "Conversation:",
    thread || "(no messages yet)",
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "intent_detection",
    taskType: "INTENT_DETECTION",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 500,
    temperature: 0.3,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, IntentAnalysisSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI intent analysis couldn't be validated — please try again." };
  }

  return { ok: true, analysis: parsed.data };
}
