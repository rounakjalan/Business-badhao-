import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";

export const ProspectResearchSchema = z.object({
  companySummary: z.string(),
  likelyNeeds: z.array(z.string()),
  possiblePainPoints: z.array(z.string()),
  relevantProductsOrServices: z.array(z.string()),
  buyingSignals: z.array(z.string()),
  personalizationOpportunities: z.array(z.string()),
  potentialObjections: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
  verifiedInformation: z.array(z.string()),
  /** Which supplied Business Knowledge facts (products, profile, differentiators) were actually drawn on — kept distinct from verifiedInformation (about the prospect) and inferredInformation (the model's own reasoning). */
  businessFactsReferenced: z.array(z.string()),
  inferredInformation: z.array(z.string()),
  unavailableInformation: z.array(z.string()),
});

export type ProspectResearch = z.infer<typeof ProspectResearchSchema>;

export type ProspectResearchInput = {
  organizationId: string;
  leadName: string;
  companyName: string | null;
  website: string | null;
  title: string | null;
  campaignName: string | null;
  campaignObjective: string | null;
  /** This organization's relevant Business Knowledge (see selectResearchContext in src/lib/business-context.ts) — null when none is on file. */
  businessContext: BusinessContext | null;
};

export type ProspectResearchResult =
  | { ok: true; research: ProspectResearch }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI research agent inside Business Badhao, a customer-acquisition CRM. You are given whatever information is already on file about a lead, plus this business's own Business Knowledge (its real profile, products/services, and differentiators) — you have NO web access and cannot look anything up. Reason only from what's given.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "companySummary": string,
  "likelyNeeds": string[],
  "possiblePainPoints": string[],
  "relevantProductsOrServices": string[],
  "buyingSignals": string[],
  "personalizationOpportunities": string[],
  "potentialObjections": string[],
  "confidence": "low" | "medium" | "high",
  "verifiedInformation": string[],
  "businessFactsReferenced": string[],
  "inferredInformation": string[],
  "unavailableInformation": string[]
}

Keep three things clearly separate: "verifiedInformation" lists ONLY facts about the PROSPECT literally present in the input (their name, company, title, etc.) — never a business fact. "businessFactsReferenced" lists which specific pieces of the supplied BUSINESS KNOWLEDGE (products, profile, differentiators) you actually drew on, e.g. "Home Theatre Installation service" — never invent a product, price, or business fact not present in BUSINESS KNOWLEDGE. "inferredInformation" is your own reasoning beyond both of those, clearly speculative. "unavailableInformation" lists what would be useful but isn't known. Never invent a specific fact (like a real statistic, a named competitor, or a company detail) that wasn't given — if little is known, say so plainly and keep confidence "low".`;

/**
 * Analyzes whatever real, already-on-file information exists about a lead
 * — plus this business's own Business Knowledge — and produces a
 * structured research summary. This is reasoning over supplied data, not
 * web research — Business Badhao has no scraping/search integration yet
 * (see agents/discovery.ts), so this agent is explicit about what it
 * actually knows about the prospect vs. references from Business Knowledge
 * vs. its own inference.
 */
export async function runProspectResearch(input: ProspectResearchInput): Promise<ProspectResearchResult> {
  const businessKnowledgeText = input.businessContext ? formatBusinessContext(input.businessContext) : null;

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (authoritative — see system prompt) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    "",
    "=== LEAD ===",
    `Lead / contact name: ${input.leadName}`,
    `Company: ${input.companyName ?? "unknown"}`,
    `Website: ${input.website ?? "unknown"}`,
    `Contact title/role: ${input.title ?? "unknown"}`,
    `Associated campaign: ${input.campaignName ?? "none"}`,
    `Campaign objective: ${input.campaignObjective ?? "unknown"}`,
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "prospect_research",
    taskType: "PROSPECT_RESEARCH",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 800,
    temperature: 0.4,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, ProspectResearchSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI research result couldn't be validated — please try again." };
  }

  return { ok: true, research: parsed.data };
}
