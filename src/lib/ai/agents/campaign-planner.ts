import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";

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
  /**
   * The organization's Business Knowledge (business_profiles,
   * products_services, faqs, business_policies, ai_communication_rules,
   * media_assets — see src/lib/business-context.ts), fetched by the
   * caller and passed in as plain data. Never fetched here — agents in
   * this codebase never touch Supabase directly, callers assemble
   * context. null when the caller has none to pass (e.g. a preview
   * call with no resolved organization).
   */
  businessContext: BusinessContext | null;
};

export type CampaignPlannerResult =
  | { ok: true; plan: CampaignPlan }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI campaign planner inside Business Badhao, a customer-acquisition CRM for small and growing businesses. You are given two distinct kinds of input, clearly separated below:

1. BUSINESS KNOWLEDGE — real, business-provided facts about what this business actually offers (profile, products/services, pricing, policies, FAQs, brand rules). This is authoritative. Treat every fact in it as ground truth.
2. CAMPAIGN INPUT — what campaign the business is trying to run right now (name, objective, description, rough target customer/location).

Using both, produce a complete, grounded campaign plan.

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

Ground every field only in the BUSINESS KNOWLEDGE and CAMPAIGN INPUT actually given. Never invent a product, price, policy, service, claim, testimonial, or business fact that isn't present in BUSINESS KNOWLEDGE — if BUSINESS KNOWLEDGE is missing or doesn't cover something a field needs, reason generally about the business type instead of fabricating a specific fact to fill the gap. Never invent competitor names or real statistics either. Everything you output is your own generated recommendation, not a fact the business supplied — it must never contradict something BUSINESS KNOWLEDGE actually says (e.g. a stated price, a stated policy).`;

/**
 * Turns a campaign's basics (name/objective/description + rough target
 * customer) plus the organization's Business Knowledge into a structured
 * plan via Hermes. This is the real replacement for the wizard's old
 * hardcoded "preview" step — the plan is generated fresh per call and
 * validated before it's ever shown or saved.
 */
export async function runCampaignPlanner(input: CampaignPlannerInput): Promise<CampaignPlannerResult> {
  const businessKnowledgeText = input.businessContext ? formatBusinessContext(input.businessContext) : null;

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (authoritative — see system prompt) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    "",
    "=== CAMPAIGN INPUT ===",
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
