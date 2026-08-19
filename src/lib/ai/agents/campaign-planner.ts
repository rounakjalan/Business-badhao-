import { z } from "zod";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";

export const CampaignPlanSchema = z.object({
  objective: z.string(),
  targetMarket: z.string(),
  customerProfile: z.string(),
  idealCustomerCharacteristics: z.array(z.string()).min(1),
  buyingSignals: z.array(z.string()).min(1),
  painPoints: z.array(z.string()).min(1),
  valueProposition: z.string(),
  suggestedChannels: z.array(z.string()).min(1),
  campaignStrategy: z.string(),
  qualificationCriteria: z.array(z.string()).min(1),
  outreachStrategy: z.string(),
  followUpStrategy: z.string(),
});

export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;

export type CampaignPlannerInput = {
  organizationId: string;
  organizationName: string;
  campaignName: string;
  objective: string;
  description: string;
  customerType: string;
  location: string;
};

export type CampaignPlannerResult =
  | { ok: true; plan: CampaignPlan }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI campaign planner inside Business Badhao, a customer-acquisition CRM for small and growing businesses. Given a campaign's basics, produce a complete, grounded campaign plan.

Respond with ONLY a single JSON object — no markdown fences, no commentary before or after — with exactly these keys:
{
  "objective": string,
  "targetMarket": string,
  "customerProfile": string,
  "idealCustomerCharacteristics": string[],
  "buyingSignals": string[],
  "painPoints": string[],
  "valueProposition": string,
  "suggestedChannels": string[],
  "campaignStrategy": string,
  "qualificationCriteria": string[],
  "outreachStrategy": string,
  "followUpStrategy": string
}

Ground every field in the information actually given. Do not invent specific competitor names, real statistics, or claims you cannot support from the input. If something is unspecified, reason generally about the business type rather than fabricating specifics.`;

/**
 * Turns a campaign's basics (name/objective/description + rough target
 * customer) into a structured plan via Hermes. This is the real
 * replacement for the wizard's old hardcoded "preview" step — the plan is
 * generated fresh per call and validated before it's ever shown or saved.
 */
export async function runCampaignPlanner(input: CampaignPlannerInput): Promise<CampaignPlannerResult> {
  const userPrompt = [
    `Organization: ${input.organizationName}`,
    `Campaign name: ${input.campaignName || "not specified"}`,
    `Objective: ${input.objective || "not specified"}`,
    `Description: ${input.description || "not specified"}`,
    `Target customer type: ${input.customerType || "not specified"}`,
    `Target location: ${input.location || "not specified"}`,
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "campaign_planner",
    taskType: "CAMPAIGN_PLANNING",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1600,
    temperature: 0.5,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, CampaignPlanSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI campaign plan couldn't be validated — please try again." };
  }

  return { ok: true, plan: parsed.data };
}
