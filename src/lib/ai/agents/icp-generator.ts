import type { CampaignPlan } from "@/lib/ai/agents/campaign-planner";
import { IcpSchema, type Icp } from "@/lib/ai/agents/icp-schema";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";

export { IcpSchema, type Icp };

export type IcpGeneratorInput = {
  organizationId: string;
  organizationName: string;
  campaignName: string;
  objective: string;
  description: string;
  /** The Campaign Planner's output for this campaign — the ICP is grounded in it, not regenerated from scratch. */
  plan: CampaignPlan;
};

export type IcpGeneratorResult =
  | { ok: true; icp: Icp }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI Ideal Customer Profile (ICP) engine inside Business Badhao, a customer-acquisition CRM used by small and growing businesses across many industries — local services, schools, agencies, SaaS, ecommerce, professional services, healthcare, education, restaurants, and more. Given a campaign's basics and its AI-generated campaign plan, produce a structured, general-purpose ICP for that specific business.

Respond with ONLY a single JSON object — no markdown fences, no commentary before or after — with exactly these keys:
{
  "targetCustomer": string,
  "ageRange": string | null,
  "location": string,
  "industry": string,
  "businessType": string | null,
  "budgetRange": string | null,
  "needs": string[],
  "painPoints": string[],
  "buyingSignals": string[],
  "decisionFactors": string[],
  "disqualifiers": string[],
  "preferredChannels": string[],
  "qualificationCriteria": string[]
}

Ground every field in the campaign basics and plan given — never invent competitor names, statistics, or specifics you cannot support from the input. Not every field applies to every business: "ageRange" rarely matters for a B2B SaaS or agency ICP, "businessType" rarely matters for a consumer-facing local service, and "budgetRange" may not be knowable yet. When a field genuinely doesn't apply to this business, return null for it rather than fabricating a plausible-sounding value — a null is more honest than a guess. Keep every list specific to this business, not generic sales boilerplate.`;

/**
 * Turns a campaign's plan (from src/lib/ai/agents/campaign-planner.ts) into
 * a structured, editable Ideal Customer Profile via Hermes. This is a
 * separate, dedicated step after the campaign plan — the plan describes
 * strategy, this describes exactly who the strategy targets.
 */
export async function runIcpGenerator(input: IcpGeneratorInput): Promise<IcpGeneratorResult> {
  const userPrompt = [
    `Organization: ${input.organizationName}`,
    `Campaign name: ${input.campaignName || "not specified"}`,
    `Objective: ${input.objective || "not specified"}`,
    `Description: ${input.description || "not specified"}`,
    `--- Campaign plan already generated for this campaign ---`,
    `Target market: ${input.plan.targetMarket}`,
    `Customer profile: ${input.plan.customerProfile}`,
    `Ideal customer characteristics: ${input.plan.idealCustomerCharacteristics.join(", ")}`,
    `Buying signals: ${input.plan.buyingSignals.join(", ")}`,
    `Pain points: ${input.plan.painPoints.join(", ")}`,
    `Value proposition: ${input.plan.valueProposition}`,
    `Suggested channels: ${input.plan.suggestedChannels.join(", ")}`,
    `Qualification criteria: ${input.plan.qualificationCriteria.join(", ")}`,
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "icp_generator",
    taskType: "ICP_GENERATION",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1600,
    temperature: 0.5,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, IcpSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI-generated ICP couldn't be validated — please try again." };
  }

  return { ok: true, icp: parsed.data };
}
