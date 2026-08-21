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
// Tavily is PRIMARY. Exa (EXA_API_KEY, also optional) is a fallback used
// only inside TavilyDiscoveryProvider's search step, only for a query whose
// Tavily call actually failed (quota/rate-limit/unavailable/network) — never
// because Tavily legitimately found zero results. See searchWithFallback.
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
    // Both LEAD_DISCOVERY calls run on reasoning models (OpenRouter's
    // Nemotron, Groq's gpt-oss), which spend part of the completion budget
    // on reasoning before emitting any JSON. In JSON mode Groq rejects the
    // whole request with HTTP 400 json_validate_failed / "max completion
    // tokens reached before generating a valid document" when the budget
    // runs out mid-document — observed in production killing entire
    // discovery runs. These ceilings leave room for that reasoning; the
    // response itself is still just a few short strings.
    maxTokens: 1200,
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
// Fallback search provider: Exa, gated behind EXA_API_KEY. Only ever called
// from searchWithFallback below, and only after Tavily's own call for that
// query has actually failed. Normalizes into the exact same SearchHit shape
// Tavily produces, so extractProspectsFromResults never needs to know which
// provider a given result came from.
// ---------------------------------------------------------------------------

const EXA_URL = "https://api.exa.ai/search";

async function exaSearch(query: string, apiKey: string): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(EXA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults: 5, contents: { text: true } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    return { ok: false, message: `Exa search failed for "${query}": ${cause instanceof Error ? cause.message : "network error"}` };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return { ok: false, message: `Exa search failed for "${query}": HTTP ${response.status} ${bodyText.slice(0, 200)}` };
  }

  let data: { results?: { title?: string; url?: string; text?: string }[] };
  try {
    data = await response.json();
  } catch {
    return { ok: false, message: `Exa search for "${query}" returned a response that could not be parsed.` };
  }

  const results = (data.results ?? [])
    .filter((r): r is { title: string; url: string; text?: string } => Boolean(r.title && r.url))
    .map((r) => ({ title: r.title, url: r.url, content: r.text ?? "" }));

  return { ok: true, results };
}

/**
 * Search Provider Router: try Tavily first — always. Only attempt Exa when
 * Tavily's own call for this specific query failed (an actual provider
 * error, never a legitimate zero-result search, which tavilySearch already
 * reports as ok:true with an empty array) and EXA_API_KEY is configured.
 * If Exa isn't configured, or Exa also fails, this surfaces exactly the
 * same failure shape callers already handled before Exa existed.
 */
async function searchWithFallback(
  query: string,
  tavilyApiKey: string,
  exaApiKey: string | undefined
): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }> {
  const tavilyResult = await tavilySearch(query, tavilyApiKey);
  if (tavilyResult.ok) return tavilyResult;
  if (!exaApiKey) return tavilyResult;

  const exaResult = await exaSearch(query, exaApiKey);
  if (exaResult.ok) return exaResult;

  return {
    ok: false,
    message: `Tavily failed (${tavilyResult.message}) and Exa fallback also failed (${exaResult.message}).`,
  };
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

/**
 * Identity of a *page*, for matching a model-cited URL back to the search
 * result it came from: host (minus "www.") + path (minus any trailing
 * slash) + query, scheme- and case-insensitive. Deliberately keeps the path
 * and query — two different pages on the same site must never collide, or
 * the grounding check would start accepting the wrong source.
 */
function canonicalizeUrl(url: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const parsed = new URL(withScheme);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!host) return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

async function extractProspectsFromResults(
  criteria: DiscoveryCriteria,
  searchesByQuery: { query: string; results: SearchHit[] }[]
): Promise<{ ok: true; prospects: DiscoveredProspect[] } | { ok: false; message: string }> {
  // Index the real search hits by a canonical form of their URL. The model
  // reliably cites the right *page* but often reformats the URL slightly
  // (adds/drops a trailing slash, drops "www.", changes scheme or case).
  // A byte-exact match against the model's string therefore threw away
  // perfectly good, genuinely-sourced prospects — the whole extraction
  // could come back empty even though every result was real. Matching
  // canonically keeps the anti-fabrication guarantee (an invented URL still
  // has a different host/path and is still dropped) while no longer losing
  // real ones to formatting noise.
  const realHitByCanonicalUrl = new Map<string, SearchHit>();
  for (const search of searchesByQuery) {
    for (const hit of search.results) {
      const key = canonicalizeUrl(hit.url);
      if (key && !realHitByCanonicalUrl.has(key)) realHitByCanonicalUrl.set(key, hit);
    }
  }

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
    // Headroom for reasoning tokens plus a multi-prospect JSON document —
    // see the note on the query-generation call above.
    maxTokens: 6000,
    temperature: 0.2,
    responseFormat: "json",
  });

  if (!result.ok) return { ok: false, message: result.message };

  const parsed = parseAiJson(result.text, ExtractionResponseSchema);
  if (!parsed.ok) return { ok: false, message: "Could not extract prospects from search results — please try again." };

  // Anti-fabrication guard: drop anything citing a URL that wasn't
  // actually in the search results — the model is not trusted to have
  // cited real evidence just because it was instructed to. Anything that
  // survives is rewritten to carry the provider's own URL and, when the
  // model's quote can't be found in the real page text, the provider's own
  // excerpt — so a stored prospect's source and evidence always come from
  // the actual search result rather than from the model's rendering of it.
  const grounded: DiscoveredProspect[] = [];
  for (const prospect of parsed.data.prospects) {
    const companyName = prospect.companyName.trim();
    if (!companyName) continue;

    const canonical = canonicalizeUrl(prospect.sourceUrl);
    const realHit = canonical ? realHitByCanonicalUrl.get(canonical) : undefined;
    if (!realHit) continue;

    const quote = prospect.evidenceSnippet.trim();
    const quoteIsReal = quote.length > 0 && realHit.content.includes(quote);

    grounded.push({
      ...prospect,
      companyName,
      sourceUrl: realHit.url,
      evidenceSnippet: quoteIsReal || !realHit.content ? quote : truncate(realHit.content, 300),
    });
  }

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

  /** Exa is an optional fallback for this provider's own search step — never required for Tavily discovery to work. */
  private get exaApiKey(): string | undefined {
    return process.env.EXA_API_KEY;
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

    const exaApiKey = this.exaApiKey;

    const queriesResult = await generateDiscoveryQueries(criteria);
    if (!queriesResult.ok) {
      return { ok: false, code: "provider_error", message: queriesResult.message };
    }

    const outcomes = await Promise.all(
      queriesResult.queries.map(async (query) => ({ query, result: await searchWithFallback(query, apiKey, exaApiKey) }))
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
