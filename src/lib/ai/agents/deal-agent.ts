import { z } from "zod";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";

export const DealRecommendationSchema = z.object({
  negotiationState: z.string(),
  requirements: z.array(z.string()),
  requestedProductOrService: z.string().nullable(),
  priceDiscussionSummary: z.string().nullable(),
  objections: z.array(z.string()),
  decisionMakerStatus: z.enum(["confirmed_decision_maker", "involves_decision_maker", "unknown"]),
  closingReadiness: z.enum(["low", "medium", "high"]),
  recommendedNextAction: z.string(),
});

export type DealRecommendation = z.infer<typeof DealRecommendationSchema>;

export type DealAgentInput = {
  organizationId: string;
  dealTitle: string;
  value: number;
  currency: string;
  status: string;
  leadName: string;
  channel: string | null;
  messages: { direction: string; senderType: string; body: string }[];
};

export type DealAgentResult = { ok: true; recommendation: DealRecommendation } | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI deal agent inside Business Badhao, a customer-acquisition CRM, helping move a high-intent prospect toward closing. You never close a deal yourself — a human always makes that call — you only analyze and recommend.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "negotiationState": string,
  "requirements": string[],
  "requestedProductOrService": string | null,
  "priceDiscussionSummary": string | null,
  "objections": string[],
  "decisionMakerStatus": "confirmed_decision_maker" | "involves_decision_maker" | "unknown",
  "closingReadiness": "low" | "medium" | "high",
  "recommendedNextAction": string
}

Base everything on the deal record and conversation given. If price or decision-maker status was never discussed, say so plainly (null / "unknown") rather than guessing.`;

/**
 * Analyzes a deal's real conversation history and current record to
 * recommend a next action. Never changes the deal's status — that stays a
 * human decision (markDealWon/markDealLost) — this only informs it.
 */
export async function runDealAgent(input: DealAgentInput): Promise<DealAgentResult> {
  const thread = input.messages.map((m) => `[${m.direction === "inbound" ? "Lead" : m.senderType}]: ${m.body}`).join("\n");

  const userPrompt = [
    `Deal: ${input.dealTitle}`,
    `Value: ${input.value} ${input.currency}`,
    `Status: ${input.status}`,
    `Lead: ${input.leadName}`,
    `Channel: ${input.channel ?? "unknown"}`,
    "",
    "Conversation:",
    thread || "(no conversation on file)",
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "deal_agent",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 600,
    temperature: 0.4,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, DealRecommendationSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI deal recommendation couldn't be validated — please try again." };
  }

  return { ok: true, recommendation: parsed.data };
}
