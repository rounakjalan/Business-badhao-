import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";

// Lead Discovery: ICP + campaign -> real search queries -> a real search
// provider -> AI extraction constrained to what the search actually
// returned -> deduped candidate prospects. No provider ships configured —
// an AI model is not a web scraper, and this app does not include any
// search/scraping service's credentials. See TavilyDiscoveryProvider below
// for the one reference implementation; NullDiscoveryProvider remains the
// honest default until TAVILY_API_KEY is set.
//
// Deliberately NOT Lead Qualification and NOT Lead Research: this module
// only surfaces candidates worth researching, with evidence for why. It
// never scores ICP fit (qualification.ts's job) and never produces a
// research summary (prospect-research.ts's job) — see the handoff at the
// bottom of this file.

export type DiscoveredProspect = {
  companyName: string;
  website: string | null;
  location: string | null;
  industry: string | null;
  businessType: string | null;
  email: string | null;
  phone: string | null;
  sourceUrl: string;
  /** The actual excerpt from the search result that supports this prospect — never AI-invented text. */
  evidenceSnippet: string;
  /** Which ICP criteria this prospect appears to match, in the model's own words — a judgment, not a verified fact. */
  matchedIcpCriteria: string[];
  /** The generated search query that surfaced this prospect. */
  searchQuery: string;
};

export type DiscoveryCriteria = {
  organizationId: string;
  campaignName: string;
  campaignObjective: string | null;
  /** The campaign's saved ICP (ideal_customer_profiles.criteria) — the primary discovery target. Required: discovery should never run without one. */
  icpCriteria: Record<string, unknown>;
  /** Minimal, discovery-relevant Business Knowledge (see selectDiscoveryContext in src/lib/business-context.ts) — not the full dataset. */
  businessContext: BusinessContext | null;
};

export type DiscoveryResult =
  | { ok: true; prospects: DiscoveredProspect[]; queriesRun: string[]; queriesFailed: string[] }
  | { ok: false; code: "not_configured" | "provider_error"; message: string };

export interface DiscoveryProvider {
  readonly name: string;
  isConfigured(): boolean;
  discover(criteria: DiscoveryCriteria): Promise<DiscoveryResult>;
}

/**
 * Honest default: no discovery source is connected. Returns a controlled
 * "not_configured" result rather than fabricating prospects.
 */
export class NullDiscoveryProvider implements DiscoveryProvider {
  readonly name = "none";

  isConfigured(): boolean {
    return false;
  }

  async discover(): Promise<DiscoveryResult> {
    return {
      ok: false,
      code: "not_configured",
      message: "Lead discovery isn't connected to a data source yet.",
    };
  }
}

// ---------------------------------------------------------------------------
// Step 1 (AI, deterministic-bounded): ICP + campaign -> search query strings.
// ---------------------------------------------------------------------------

const DiscoveryQueriesSchema = z.object({ queries: z.array(z.string().min(1)).min(1).max(5) });

const QUERY_SYSTEM_PROMPT = `You turn a business's Ideal Customer Profile and campaign into real web search queries that would surface actual companies/prospects matching that profile. You are given BUSINESS KNOWLEDGE (what this business offers — context only, do not search for the business itself), the CAMPAIGN, and the IDEAL CUSTOMER PROFILE (the primary target — who to find).

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly this key:
{ "queries": string[] }

Produce 3-5 distinct, realistic search-engine queries (not questions, not full sentences with filler words) that a human researcher would actually type to find real businesses/prospects matching the ICP's location, industry, business type, and buying signals. Ground every query in the ICP fields actually given — never invent an industry, location, or characteristic not present in the ICP.`;

async function generateDiscoveryQueries(
  criteria: DiscoveryCriteria
): Promise<{ ok: true; queries: string[] } | { ok: false; message: string }> {
  const businessKnowledgeText = criteria.businessContext ? formatBusinessContext(criteria.businessContext) : null;

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (context only — not the search target) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    "",
    "=== CAMPAIGN ===",
    `Campaign: ${criteria.campaignName}`,
    `Objective: ${criteria.campaignObjective ?? "unknown"}`,
    "",
    "=== IDEAL CUSTOMER PROFILE (the search target) ===",
    JSON.stringify(criteria.icpCriteria),
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: criteria.organizationId,
    agentType: "lead_discovery_query_generation",
    taskType: "LEAD_DISCOVERY",
    systemPrompt: QUERY_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 400,
    temperature: 0.4,
    responseFormat: "json",
  });

  if (!result.ok) return { ok: false, message: result.message };

  const parsed = parseAiJson(result.text, DiscoveryQueriesSchema);
  if (!parsed.ok) return { ok: false, message: "Could not generate discovery search queries — please try again." };

  return { ok: true, queries: parsed.data.queries };
}

// ---------------------------------------------------------------------------
// Step 2 (deterministic): run each query against a real search provider.
// ---------------------------------------------------------------------------

type SearchHit = { title: string; url: string; content: string };

const TAVILY_URL = "https://api.tavily.com/search";

async function tavilySearch(query: string, apiKey: string): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: "basic" }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    return { ok: false, message: `Search failed for "${query}": ${cause instanceof Error ? cause.message : "network error"}` };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return { ok: false, message: `Search failed for "${query}": HTTP ${response.status} ${bodyText.slice(0, 200)}` };
  }

  let data: { results?: { title?: string; url?: string; content?: string }[] };
  try {
    data = await response.json();
  } catch {
    return { ok: false, message: `Search for "${query}" returned a response that could not be parsed.` };
  }

  const results = (data.results ?? [])
    .filter((r): r is { title: string; url: string; content?: string } => Boolean(r.title && r.url))
    .map((r) => ({ title: r.title, url: r.url, content: r.content ?? "" }));

  return { ok: true, results };
}

// ---------------------------------------------------------------------------
// Step 3 (AI, bounded to the given results): extract distinct real
// prospects from real search results. Every sourceUrl is cross-checked
// against the actual URLs returned by the search — an extracted prospect
// citing a URL that was never in the results is dropped, not trusted.
// ---------------------------------------------------------------------------

const ExtractedProspectSchema = z.object({
  companyName: z.string(),
  website: z.string().nullable(),
  location: z.string().nullable(),
  industry: z.string().nullable(),
  businessType: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  matchedIcpCriteria: z.array(z.string()),
  evidenceSnippet: z.string(),
  sourceUrl: z.string(),
  searchQuery: z.string(),
});
const ExtractionResponseSchema = z.object({ prospects: z.array(ExtractedProspectSchema) });

const EXTRACTION_SYSTEM_PROMPT = `You extract real, distinct prospect companies from real web search results — you never invent a company that isn't actually described in the results given to you. You are given a numbered list of real search results (query, title, URL, content excerpt) and the Ideal Customer Profile they were searched for.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly this key:
{
  "prospects": [
    {
      "companyName": string,
      "website": string | null,
      "location": string | null,
      "industry": string | null,
      "businessType": string | null,
      "email": string | null,
      "phone": string | null,
      "matchedIcpCriteria": string[],
      "evidenceSnippet": string,
      "sourceUrl": string,
      "searchQuery": string
    }
  ]
}

Rules: every "sourceUrl" MUST be copied exactly from one of the given results' URLs — never a URL you construct or guess. "evidenceSnippet" MUST be an actual excerpt from that result's content — never invented text. Every field besides companyName, sourceUrl, evidenceSnippet, and searchQuery must be null unless the result's own content actually states it — a search result rarely states an email or phone directly, so leave those null unless genuinely present. Do not list the same company twice even if it appeared in multiple results — merge them into one entry citing the most informative result. Skip a result entirely if it isn't a real, identifiable business (e.g. a generic article, directory homepage, or listing with no single named company). If nothing in the results is a real matching prospect, return an empty array — never fabricate one to avoid returning nothing.`;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function extractProspectsFromResults(
  criteria: DiscoveryCriteria,
  searchesByQuery: { query: string; results: SearchHit[] }[]
): Promise<{ ok: true; prospects: DiscoveredProspect[] } | { ok: false; message: string }> {
  const validUrls = new Set(searchesByQuery.flatMap((s) => s.results.map((r) => r.url)));

  const resultsText = searchesByQuery
    .flatMap((s) =>
      s.results.map(
        (r, i) => `[Query: "${s.query}"] Result ${i + 1}: "${r.title}"\nURL: ${r.url}\nContent: ${truncate(r.content, 600)}`
      )
    )
    .join("\n\n");

  const userPrompt = [
    "=== IDEAL CUSTOMER PROFILE ===",
    JSON.stringify(criteria.icpCriteria),
    "",
    "=== REAL SEARCH RESULTS ===",
    resultsText || "(no results)",
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: criteria.organizationId,
    agentType: "lead_discovery_extraction",
    taskType: "LEAD_DISCOVERY",
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1800,
    temperature: 0.2,
    responseFormat: "json",
  });

  if (!result.ok) return { ok: false, message: result.message };

  const parsed = parseAiJson(result.text, ExtractionResponseSchema);
  if (!parsed.ok) return { ok: false, message: "Could not extract prospects from search results — please try again." };

  // Anti-fabrication guard: drop anything citing a URL that wasn't
  // actually in the search results — the model is not trusted to have
  // cited real evidence just because it was instructed to.
  const grounded = parsed.data.prospects.filter((p) => validUrls.has(p.sourceUrl));

  return { ok: true, prospects: grounded };
}

// ---------------------------------------------------------------------------
// Deduplication (within one discovery run) — canonical domain first,
// normalized company name as a fallback for prospects with no website.
// ---------------------------------------------------------------------------

export function normalizeWebsite(website: string | null): string | null {
  if (!website) return null;
  try {
    const withScheme = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    const hostname = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
    return hostname || null;
  } catch {
    return null;
  }
}

export function prospectDedupeKey(prospect: Pick<DiscoveredProspect, "website" | "companyName">): string {
  return normalizeWebsite(prospect.website) ?? `name:${prospect.companyName.trim().toLowerCase()}`;
}

export function dedupeProspects(prospects: DiscoveredProspect[]): DiscoveredProspect[] {
  const seen = new Set<string>();
  const deduped: DiscoveredProspect[] = [];
  for (const prospect of prospects) {
    const key = prospectDedupeKey(prospect);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(prospect);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Real provider: Tavily search, gated entirely behind TAVILY_API_KEY.
// ---------------------------------------------------------------------------

export class TavilyDiscoveryProvider implements DiscoveryProvider {
  readonly name = "tavily";

  private get apiKey(): string | undefined {
    return process.env.TAVILY_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveryResult> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      return {
        ok: false,
        code: "not_configured",
        message: "Lead discovery isn't connected to a search provider yet — TAVILY_API_KEY is not set.",
      };
    }

    const queriesResult = await generateDiscoveryQueries(criteria);
    if (!queriesResult.ok) {
      return { ok: false, code: "provider_error", message: queriesResult.message };
    }

    const outcomes = await Promise.all(
      queriesResult.queries.map(async (query) => ({ query, result: await tavilySearch(query, apiKey) }))
    );
    const succeeded = outcomes.filter((o): o is { query: string; result: { ok: true; results: SearchHit[] } } => o.result.ok);
    const queriesFailed = outcomes.filter((o) => !o.result.ok).map((o) => o.query);

    if (succeeded.length === 0) {
      const firstError = outcomes[0]?.result as { ok: false; message: string } | undefined;
      return {
        ok: false,
        code: "provider_error",
        message: `All ${queriesResult.queries.length} discovery searches failed.${firstError ? ` First error: ${firstError.message}` : ""}`,
      };
    }

    const totalHits = succeeded.reduce((sum, o) => sum + o.result.results.length, 0);
    if (totalHits === 0) {
      return { ok: true, prospects: [], queriesRun: succeeded.map((o) => o.query), queriesFailed };
    }

    const extraction = await extractProspectsFromResults(
      criteria,
      succeeded.map((o) => ({ query: o.query, results: o.result.results }))
    );
    if (!extraction.ok) {
      return { ok: false, code: "provider_error", message: extraction.message };
    }

    return {
      ok: true,
      prospects: dedupeProspects(extraction.prospects),
      queriesRun: succeeded.map((o) => o.query),
      queriesFailed,
    };
  }
}

/** Swap point: nothing else needs to change to add another provider. */
export function getDiscoveryProvider(): DiscoveryProvider {
  const tavily = new TavilyDiscoveryProvider();
  return tavily.isConfigured() ? tavily : new NullDiscoveryProvider();
}

// ---------------------------------------------------------------------------
// Handoff to Lead Research: Discovery's job ends at a persisted prospect +
// lead record (see startLeadDiscoveryAction in campaigns/actions.ts, which
// creates prospects/leads rows from DiscoveredProspect and never scores or
// researches them itself). From there the EXISTING runLeadResearchAction
// (leads/actions.ts) — unchanged — takes over via the lead's id, exactly as
// it already does for any manually-added lead. Discovery does not call
// Research directly; it just makes a real lead available for it.
// ---------------------------------------------------------------------------
