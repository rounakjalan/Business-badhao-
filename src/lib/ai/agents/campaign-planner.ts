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
  /**
   * The plan already on screen, when the user is asking for changes to it
   * rather than a fresh one. Paired with refinementRequest — supplying one
   * without the other is treated as a normal first-time generation.
   */
  currentPlan?: CampaignPlan | null;
  /** What the user wants changed, in their own words. */
  refinementRequest?: string | null;
};

export type CampaignPlannerResult =
  | {
      ok: true;
      plan: CampaignPlan;
      /**
       * Which fields the revision actually altered. Empty on a first-time
       * generation. Computed by comparing before/after rather than trusted
       * from the model, so the UI can show what really moved.
       */
      changedFields: CampaignPlanField[];
    }
  | { ok: false; message: string };

export type CampaignPlanField = keyof CampaignPlan;

/**
 * Fields whose value differs between two plans. Used to prove a refinement
 * edited the plan instead of quietly rewriting all of it — the difference
 * the user actually asked for.
 */
export function diffPlanFields(before: CampaignPlan, after: CampaignPlan): CampaignPlanField[] {
  return (Object.keys(after) as CampaignPlanField[]).filter((key) => {
    const a = before[key];
    const b = after[key];
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length !== b.length || a.some((item, i) => item !== b[i]);
    }
    return a !== b;
  });
}

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
 * Revision mode. The user has a plan they mostly like and wants specific
 * changes — so this edits that plan rather than writing a new one. The
 * strong preservation rule is what makes "revise" meaningfully different
 * from "regenerate", which the wizard offers separately.
 */
const REFINE_SYSTEM_PROMPT = `You are the AI campaign planner inside Business Badhao, a customer-acquisition CRM for small and growing businesses. The business already has a campaign plan and wants you to CHANGE it — not replace it.

You are given, clearly separated below:
1. BUSINESS KNOWLEDGE — real, business-provided facts about what this business actually offers. Authoritative, treat as ground truth.
2. CAMPAIGN INPUT — the campaign's basics.
3. CURRENT PLAN — the plan as it stands right now.
4. REQUESTED CHANGES — what the business wants different, in their own words.

Your job is to return the CURRENT PLAN with the REQUESTED CHANGES applied.

Rules for revising:
- Keep every field the request does not touch EXACTLY as it is, character for character. Do not reword, re-order, tidy, or "improve" anything you were not asked to change.
- Change only what the request actually calls for, plus any field that would directly contradict it if left alone. If narrowing the target market makes a stated buying signal impossible, update that signal too — but do not go further than that.
- If the request is vague, make the smallest reasonable change that satisfies it rather than rewriting broadly.
- If the request asks for something that would contradict BUSINESS KNOWLEDGE (a price, a policy, a service the business does not offer), do not comply with that part. Keep the field grounded and leave it consistent with BUSINESS KNOWLEDGE.
- If the request cannot be applied to any field at all, return the CURRENT PLAN completely unchanged.

Respond with ONLY a single JSON object — no markdown fences, no commentary before or after — containing the complete plan with exactly these keys:
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

Return the whole plan every time, including the untouched fields. Never invent a product, price, policy, service, claim, or statistic that isn't present in BUSINESS KNOWLEDGE.`;

/**
 * Turns a campaign's basics (name/objective/description + rough target
 * customer) plus the organization's Business Knowledge into a structured
 * plan via Hermes. This is the real replacement for the wizard's old
 * hardcoded "preview" step — the plan is generated fresh per call and
 * validated before it's ever shown or saved.
 */
export async function runCampaignPlanner(input: CampaignPlannerInput): Promise<CampaignPlannerResult> {
  const businessKnowledgeText = input.businessContext ? formatBusinessContext(input.businessContext) : null;

  // Revising needs both a plan to revise and something to change about it.
  // With only one of the two there is nothing to preserve, so this is a
  // normal generation.
  const refinementRequest = input.refinementRequest?.trim();
  const isRefinement = Boolean(input.currentPlan && refinementRequest);

  const campaignInput = [
    "=== CAMPAIGN INPUT ===",
    `Organization: ${input.organizationName}`,
    `Campaign name: ${input.campaignName || "not specified"}`,
    `Objective: ${input.objective || "not specified"}`,
    `Description: ${input.description || "not specified"}`,
    `Target customer type: ${input.customerType || "not specified"}`,
    `Target location: ${input.location || "not specified"}`,
  ];

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (authoritative — see system prompt) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    "",
    ...campaignInput,
    ...(isRefinement
      ? [
          "",
          "=== CURRENT PLAN (revise this — keep untouched fields exactly as they are) ===",
          JSON.stringify(input.currentPlan, null, 2),
          "",
          "=== REQUESTED CHANGES (the business's own words) ===",
          refinementRequest as string,
        ]
      : []),
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "campaign_planner",
    taskType: "CAMPAIGN_PLANNING",
    systemPrompt: isRefinement ? REFINE_SYSTEM_PROMPT : SYSTEM_PROMPT,
    userPrompt,
    // A revision echoes the whole plan back plus the current plan in the
    // prompt, so it needs materially more room than a first generation.
    maxTokens: isRefinement ? 2600 : 1600,
    // Lower on a revision: the job is targeted editing, not fresh ideas.
    temperature: isRefinement ? 0.3 : 0.5,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, CampaignPlanSchema);
  if (!parsed.ok) {
    return {
      ok: false,
      message: isRefinement
        ? "The AI couldn't apply those changes — try describing them differently."
        : "The AI campaign plan couldn't be validated — please try again.",
    };
  }

  return {
    ok: true,
    plan: parsed.data,
    changedFields: input.currentPlan ? diffPlanFields(input.currentPlan, parsed.data) : [],
  };
}
