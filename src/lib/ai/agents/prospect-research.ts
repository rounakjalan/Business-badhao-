import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { ProspectResearchSchema, type ProspectResearch } from "@/lib/ai/agents/prospect-research-schema";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";

export { ProspectResearchSchema, type ProspectResearch };

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
  /**
   * The real, already-grounded evidence Lead Discovery captured for this
   * prospect (src/lib/prospects.ts's ProspectRawData) — the actual search
   * excerpt, the ICP criteria discovery judged it matches, and any verified
   * contact channel. Without this the research agent had almost nothing
   * prospect-specific to reason over (see loadLeadContext in
   * lib/pipeline/lead-pipeline.ts), which is why research confidence was
   * effectively always low — there was rarely any real evidence behind it.
   */
  discoveryEvidence: DiscoveryEvidence | null;
};

export type DiscoveryEvidence = {
  location: string | null;
  industry: string | null;
  businessType: string | null;
  matchedIcpCriteria: string[];
  evidenceSnippet: string | null;
  sourceUrl: string | null;
  hasVerifiedContact: boolean;
};

export type ProspectResearchResult =
  | { ok: true; research: ProspectResearch }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI research agent inside Business Badhao, a customer-acquisition CRM. You are given whatever information is already on file about a lead — which may include real DISCOVERY EVIDENCE: an actual excerpt from the web page that surfaced this prospect, its source URL, and which Ideal Customer Profile criteria it was judged to match — plus this business's own Business Knowledge (its real profile, products/services, and differentiators). You have NO web access of your own and cannot look anything up beyond what's given.

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

Keep three things clearly separate: "verifiedInformation" lists ONLY facts about the PROSPECT literally present in the input — their name, company, title, location, industry, matched ICP criteria, and anything the DISCOVERY EVIDENCE excerpt actually states — never a business fact, and never something the excerpt does not actually say. "businessFactsReferenced" lists which specific pieces of the supplied BUSINESS KNOWLEDGE (products, profile, differentiators) you actually drew on, e.g. "Home Theatre Installation service" — never invent a product, price, or business fact not present in BUSINESS KNOWLEDGE. "likelyNeeds"/"possiblePainPoints"/"buyingSignals" should be grounded in the DISCOVERY EVIDENCE excerpt where possible (cite what it actually says), not invented from the company name alone. "inferredInformation" is your own reasoning beyond both of those, clearly speculative — a real evidence excerpt supports reasonable inference; the absence of one does not. "unavailableInformation" lists what would be useful but isn't known — be specific and honest about this, since it directly affects how much this research can be trusted. Never invent a specific fact (like a real statistic, a named competitor, or a company detail) that wasn't given. Set "confidence" honestly: "high" only when the discovery evidence excerpt directly supports the prospect's identity and relevant need; "low" when there is no real excerpt to work from or almost everything is inferred rather than verified.`;

const NO_DISCOVERY_EVIDENCE = "No discovery evidence on file for this lead — it was likely added manually rather than found by Lead Discovery. Treat the prospect as largely unverified.";

function formatDiscoveryEvidence(evidence: DiscoveryEvidence | null): string {
  if (!evidence) return NO_DISCOVERY_EVIDENCE;

  const lines = [
    `Location: ${evidence.location ?? "unknown"}`,
    `Industry: ${evidence.industry ?? "unknown"}`,
    `Business type: ${evidence.businessType ?? "unknown"}`,
    `ICP criteria this prospect was judged to match: ${evidence.matchedIcpCriteria.length > 0 ? evidence.matchedIcpCriteria.join("; ") : "none recorded"}`,
    `Verified contact channel on file: ${evidence.hasVerifiedContact ? "yes" : "no"}`,
  ];
  if (evidence.sourceUrl) lines.push(`Source page: ${evidence.sourceUrl}`);
  lines.push(
    evidence.evidenceSnippet
      ? `Real excerpt from that source page (this is actual evidence, not a claim you're being asked to trust blindly — quote or paraphrase it, don't ignore it): "${evidence.evidenceSnippet}"`
      : "No real excerpt was captured for this prospect."
  );
  return lines.join("\n");
}

/**
 * Analyzes whatever real, already-on-file information exists about a lead
 * — its real discovery evidence (when Lead Discovery found it) plus this
 * business's own Business Knowledge — and produces a structured research
 * summary. This is reasoning over supplied data, not independent web
 * research — Business Badhao has no scraping/search integration of its
 * own here (that already happened once, in agents/discovery.ts) — so this
 * agent is explicit about what it actually knows about the prospect vs.
 * references from Business Knowledge vs. its own inference.
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
    "",
    "=== DISCOVERY EVIDENCE (real, grounded evidence about the PROSPECT — the only source of truth about them beyond what's listed above) ===",
    formatDiscoveryEvidence(input.discoveryEvidence),
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "prospect_research",
    taskType: "PROSPECT_RESEARCH",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    // This schema is the largest of any agent — 12 keys, 10 of them string
    // arrays — so 800 could not fit a complete document: the sparsest
    // possible lead (no contact, no website, no title) already spent ~660 of
    // it. Providers in strict JSON mode then reject the truncated output
    // outright ("max completion tokens reached before generating a valid
    // document") rather than returning partial JSON, so research failed for
    // any lead with real substance. 1600 matches what campaign-planner and
    // icp-generator use for comparably sized schemas. This is a ceiling, not
    // a reservation — small responses still cost what they cost.
    maxTokens: 1600,
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
