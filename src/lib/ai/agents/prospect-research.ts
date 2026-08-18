import { z } from "zod";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";

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
};

export type ProspectResearchResult =
  | { ok: true; research: ProspectResearch }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI research agent inside Business Badhao, a customer-acquisition CRM. You are given whatever information is already on file about a lead — you have NO web access and cannot look anything up. Reason only from what's given.

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
  "inferredInformation": string[],
  "unavailableInformation": string[]
}

"verifiedInformation" must list ONLY facts literally present in the input. "inferredInformation" is your reasoning beyond those facts, clearly speculative. "unavailableInformation" lists what would be useful but isn't known. Never invent a specific fact (like a real statistic, a named competitor, or a company detail) that wasn't given — if little is known, say so plainly and keep confidence "low".`;

/**
 * Analyzes whatever real, already-on-file information exists about a lead
 * and produces a structured research summary. This is reasoning over
 * supplied data, not web research — Business Badhao has no scraping/search
 * integration yet (see agents/discovery.ts), so this agent is explicit
 * about what it actually knows vs. infers vs. doesn't have.
 */
export async function runProspectResearch(input: ProspectResearchInput): Promise<ProspectResearchResult> {
  const userPrompt = [
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
