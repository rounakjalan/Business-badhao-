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

const QUERY_SYSTEM_PROMPT = `You write web search queries that find POTENTIAL CUSTOMERS for a business.

You are given WHAT THIS BUSINESS SELLS (seller-side context) and an IDEAL CUSTOMER PROFILE describing the buyer to find. Your queries must find the BUYER.

THE MOST IMPORTANT RULE: never search for other businesses that sell or supply what this business sells. Agencies, firms, studios, freelancers, vendors, consultants and service providers in the seller's own field are COMPETITORS, not customers. A query like "web design agency in <city>" finds competitors and is always wrong for a business that sells web design. The only exception is when the ICP's targetCustomer / industry / businessType explicitly names those providers as the people to find.

YOUR JOB IS TO FIND PAGES THAT NAME REAL BUSINESSES. A business that needs what the seller offers almost never publishes that need, so searching for the need itself ("small business with an outdated website") returns blog posts and listicles with no company in them. Instead, search the way you would to build a list of businesses: the kind of business plus its location, aimed at sources that actually name individual companies — business directories, local and chamber-of-commerce listings, association and member lists, marketplace or map-style category pages, "top/best <industry> in <city>" roundups, and industry association pages.

How to use each ICP field:
- targetCustomer, industry, businessType — WHO to find. This is the backbone of every query. If the ICP names several industries or is broad ("SMEs"), pick concrete, searchable industries that fit it and vary them across queries.
- location / service area — WHERE. Include it in essentially every query.
- painPoints, needs, and any stated website/quality signals — these are QUALIFICATION signals, checked later once a real business is found. They are NOT required search terms. At most one of your queries may use them, and never at the cost of naming an actual kind of business and place.
- buyingSignals — use ONLY signals that are an observable property of the prospect itself. Never turn a signal that describes the buyer looking for, hiring, comparing or contacting a provider into a query — searching for that phrase returns the providers, not the buyer.
- preferredChannels, decisionFactors, qualificationCriteria, disqualifiers — these describe how to reach, evaluate or exclude a buyer. They are NOT search targets. Do not build queries from them.

Ignore the campaign's name and the seller's own name: they describe the seller, not the prospect.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly this key:
{ "queries": string[] }

Produce 3-5 distinct, realistic search-engine queries (keywords a researcher would actually type, not questions or full sentences). Each query must name a kind of business and a place, and should aim at a source that lists real companies. Vary the industry and the kind of source across the queries rather than rewording one idea. Ground every query in the ICP fields actually given — never invent a location or a characteristic that is not present in the ICP; where the ICP's industry is broad, choosing concrete industries that genuinely fall inside it is expected, not invention.`;

/**
 * Words that name a *supplier of services* almost regardless of context —
 * "digital marketing agencies in Noida" is looking for vendors whichever
 * trade is named. When the ICP is after ordinary businesses, any query
 * built around one of these is off-target.
 */
const SUPPLIER_NOUNS = new Set([
  "agency",
  "agencies",
  "freelancer",
  "freelancers",
  "consultancy",
  "consultancies",
  "vendor",
  "vendors",
]);

/**
 * Words that name a supplier only when paired with what this business
 * sells. A "web development company" is a competitor; a "law firm", a
 * "yoga studio" or plain "companies in Noida" is a perfectly good buyer —
 * so these only count next to one of the seller's own offering words.
 */
const AMBIGUOUS_PROVIDER_NOUNS = new Set([
  "firm",
  "firms",
  "studio",
  "studios",
  "provider",
  "providers",
  "consultant",
  "consultants",
  "company",
  "companies",
  "developer",
  "developers",
  "designer",
  "designers",
]);

const PROVIDER_NOUNS = new Set([...SUPPLIER_NOUNS, ...AMBIGUOUS_PROVIDER_NOUNS]);

const QUERY_STOPWORDS = new Set(["the", "and", "for", "with", "our", "your", "best", "top", "near", "list", "of", "in", "at", "to", "a", "an"]);

function queryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Loose token match so "design" and "designing" count as the same offering word. */
function tokensRelated(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 4 && longer.startsWith(shorter);
}

/**
 * The words describing what this business itself sells — used only to
 * recognise a query that has gone looking for a competitor. Drawn from the
 * campaign name and, when Business Knowledge exists, the business's own
 * category and product names. Provider nouns are stripped: in "Web
 * designing agency" the offering is "web designing", not "agency".
 */
function sellerOfferingTokens(criteria: DiscoveryCriteria): string[] {
  const sources = [criteria.campaignName];
  const profile = criteria.businessContext?.businessProfile;
  if (profile?.category) sources.push(profile.category);
  if (profile?.name) sources.push(profile.name);
  for (const product of criteria.businessContext?.productsServices ?? []) sources.push(product.name);

  return [...new Set(sources.flatMap(queryTokens))].filter(
    (token) => token.length >= 3 && !QUERY_STOPWORDS.has(token) && !PROVIDER_NOUNS.has(token)
  );
}

/** True when the ICP itself is asking for providers (e.g. selling white-label to agencies), which makes competitor-shaped queries correct. */
function icpTargetsProviders(icpCriteria: Record<string, unknown>): boolean {
  const targeting = [icpCriteria.targetCustomer, icpCriteria.industry, icpCriteria.businessType]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return queryTokens(targeting).some((token) => PROVIDER_NOUNS.has(token));
}

/**
 * True when a query is looking for a supplier of what this business sells —
 * i.e. a competitor rather than a buyer. Recognised as one of the seller's
 * own offering words sitting immediately before a provider noun ("web
 * design agency", "web development company"). The adjacency matters: it is
 * what keeps a legitimate buyer query like "law firms with an outdated
 * website" from being mistaken for a competitor search.
 */
export function isCompetitorSeekingQuery(query: string, sellerTokens: string[]): boolean {
  const tokens = queryTokens(query);

  return tokens.some((token, index) => {
    // Unambiguous supplier word anywhere in the query — this covers the
    // seller's own trade and the adjacent ones ("SEO agency", "digital
    // marketing agencies"), which are competitors just the same.
    if (SUPPLIER_NOUNS.has(token)) return true;

    if (!AMBIGUOUS_PROVIDER_NOUNS.has(token) || sellerTokens.length === 0) return false;
    const preceding = tokens.slice(Math.max(0, index - 3), index);
    return preceding.some((prev) => sellerTokens.some((seller) => tokensRelated(prev, seller)));
  });
}

/** Last-resort query built only from ICP fields the user actually saved — never invents a characteristic. */
function icpDerivedQuery(icpCriteria: Record<string, unknown>): string | null {
  const field = (key: string) => (typeof icpCriteria[key] === "string" ? (icpCriteria[key] as string).trim() : "");
  const who = field("targetCustomer") || [field("businessType"), field("industry")].filter(Boolean).join(" ");
  if (!who) return null;
  const location = field("location");
  return location && !who.toLowerCase().includes(location.toLowerCase().split(",")[0].trim()) ? `${who} ${location}` : who;
}

async function generateDiscoveryQueries(
  criteria: DiscoveryCriteria
): Promise<{ ok: true; queries: string[] } | { ok: false; message: string }> {
  const businessKnowledgeText = criteria.businessContext ? formatBusinessContext(criteria.businessContext) : null;

  const userPrompt = [
    "=== WHAT THIS BUSINESS SELLS (seller-side — never search for other suppliers of this) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    `Campaign name (the seller's own label for this effort, not a search target): ${criteria.campaignName}`,
    `Objective: ${criteria.campaignObjective ?? "unknown"}`,
    "",
    "=== IDEAL CUSTOMER PROFILE — the BUYER to find (the search target) ===",
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

  // The prompt above asks for buyer-focused queries; this enforces it. A
  // competitor-shaped query is dropped outright rather than searched, so a
  // single stray one can't fill the run with rival agencies. Skipped when
  // the ICP genuinely targets providers.
  if (icpTargetsProviders(criteria.icpCriteria)) {
    return { ok: true, queries: parsed.data.queries };
  }

  const sellerTokens = sellerOfferingTokens(criteria);
  const buyerFocused = parsed.data.queries.filter((query) => !isCompetitorSeekingQuery(query, sellerTokens));
  if (buyerFocused.length > 0) {
    return { ok: true, queries: buyerFocused };
  }

  // Everything the model produced was aimed at competitors. Fall back to a
  // query composed only of ICP fields the user actually saved, so discovery
  // still runs against real targeting instead of searching for rivals.
  const fallback = icpDerivedQuery(criteria.icpCriteria);
  return fallback
    ? { ok: true, queries: [fallback] }
    : { ok: false, message: "Could not build buyer-focused search queries from this campaign's ICP — please refine the ICP and try again." };
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

Rules: every "sourceUrl" MUST be copied exactly from one of the given results' URLs — never a URL you construct or guess. "evidenceSnippet" MUST be an actual excerpt from that result's content — never invented text. Every field besides companyName, sourceUrl, evidenceSnippet, and searchQuery must be null unless the result's own content actually states it — a search result rarely states an email or phone directly, so leave those null unless genuinely present. Do not list the same company twice even if it appeared in multiple results — merge them into one entry citing the most informative result.

Many results are directory pages, local listings, association member lists or "top <industry> in <city>" roundups. These are valuable: extract EVERY individually named business the page actually lists, as a separate entry, all citing that page's URL. What you must never do is invent a business, or turn a page into an entry when it names none — skip a result only when it contains no identifiable company name at all (a general article, or a directory landing page that lists no companies in the text you were given). Extract the businesses being listed, never the site doing the listing.

Do not assert a problem the evidence does not show. matchedIcpCriteria may only contain criteria the result's own content actually supports; if the content says nothing about the state of the company's website, do not claim its website is outdated, missing or poor — that is checked later, not guessed here. Leave "website" null unless the content actually gives that company's own site.

If nothing in the results is a real matching prospect, return an empty array — never fabricate one to avoid returning nothing.`;

/**
 * Extraction request budget. The configured models for LEAD_DISCOVERY are
 * reasoning models on free/low tiers, where the *whole* request — prompt
 * plus the completion tokens it reserves — is charged against a per-minute
 * allowance (Groq's free tier: 8k TPM). Both of these were tuned against
 * real production failures at either end of that window; raise them only
 * together with the tier they run on.
 */
// Fewer results, longer excerpts: a directory or "top <industry> in <city>"
// page carries many businesses, and a short excerpt truncates away the very
// names we are there to collect. 12 x 600 chars plus the reserved completion
// tokens still leaves clear headroom under the 8k window.
const MAX_RESULTS_SENT_TO_EXTRACTION = 12;
const RESULT_EXCERPT_CHARS = 600;
const EXTRACTION_MAX_TOKENS = 3000;

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
  // The whole extraction request (prompt + reserved completion tokens) has
  // to fit inside the model's per-minute token allowance — Groq's free tier
  // is 8k TPM and rejects anything larger with HTTP 413, which previously
  // failed the run outright. Take an even slice from each query rather than
  // the first N overall, so capping never silently drops a whole query's
  // results, and keep excerpts short: identifying a business needs a couple
  // of sentences, not the whole page.
  const perQueryCap = Math.max(1, Math.ceil(MAX_RESULTS_SENT_TO_EXTRACTION / Math.max(1, searchesByQuery.length)));
  const sentResults = searchesByQuery
    .flatMap((s) => s.results.slice(0, perQueryCap).map((r) => ({ query: s.query, hit: r })))
    .slice(0, MAX_RESULTS_SENT_TO_EXTRACTION);

  const realHitByCanonicalUrl = new Map<string, SearchHit>();
  for (const { hit } of sentResults) {
    const key = canonicalizeUrl(hit.url);
    if (key && !realHitByCanonicalUrl.has(key)) realHitByCanonicalUrl.set(key, hit);
  }

  const resultsText = sentResults
    .map(
      ({ query, hit }, i) =>
        `[Query: "${query}"] Result ${i + 1}: "${hit.title}"\nURL: ${hit.url}\nContent: ${truncate(hit.content, RESULT_EXCERPT_CHARS)}`
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
    // Balances the two opposite failures seen in production: too low and a
    // reasoning model runs out mid-JSON (Groq HTTP 400 json_validate_failed);
    // too high and prompt + reserved completion tokens blow the 8k TPM
    // allowance (Groq HTTP 413). Together with the capped prompt above this
    // keeps the whole request comfortably inside that budget.
    maxTokens: EXTRACTION_MAX_TOKENS,
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
