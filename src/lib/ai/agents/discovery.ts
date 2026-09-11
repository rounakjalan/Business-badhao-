import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { HermesLeadDiscoveryAgent, type DiscoverySearchTool } from "@/lib/ai/agents/hermes-lead-discovery-agent";
import { runHermesCompletion, type HermesResult } from "@/lib/ai/hermes/hermes-service";
import { DEFAULT_OPENROUTER_MODEL } from "@/lib/ai/providers/openrouter";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";
import type { Database } from "@/types/database.types";

/**
 * Supabase client for this run's own agent_runs/model_usage telemetry —
 * threaded optionally through every AI call below down to
 * runHermesCompletion (see HermesRequest.client's own doc comment for why:
 * scheduled work has no signed-in user, so the default cookie-based client
 * can't write telemetry past RLS). Omit for a call made inside a real user
 * session; the manual "Start Discovery" action never passes one and is
 * unaffected by this.
 */
export type TrackingClient = SupabaseClient<Database>;

/**
 * The intended model for both Nemotron-designated stages below (query
 * generation and extraction) — reused directly from OpenRouterProvider's own
 * configured default rather than a second, independent literal, so the two
 * can never silently drift apart. Named and passed explicitly (via
 * modelByProvider, see below) instead of left for OpenRouterProvider to
 * apply implicitly: a production audit (2026-09) found that without an
 * explicit name, there was nothing to check a request against — only the
 * model that happened to answer was ever recorded, never what was actually
 * intended, which is exactly what let 100% of extraction and 78% of query
 * generation runs go to Groq's fallback model for days without that being
 * visible as a divergence from what these stages are supposed to run on.
 * This does not change which model actually gets requested when OpenRouter
 * serves the call — it is the same string OpenRouterProvider already
 * defaults to — it only makes the intent explicit and inspectable.
 */
const NEMOTRON_MODEL = DEFAULT_OPENROUTER_MODEL;

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
//
// Runtime call graph, named against the app's own terms for these layers.
//
// UPDATED (2026-09, post-audit): "Hermes" now means TWO distinct things in
// this codebase, and they must not be confused with each other:
//
//   1. runHermesCompletion (hermes-service.ts) — shared AI infrastructure.
//      The generic routing/telemetry wrapper every AI feature in this app
//      calls through to actually reach a model. It has no opinion about
//      Lead Discovery specifically; it just routes, retries, falls back,
//      and records telemetry for whatever request it's given.
//   2. HermesLeadDiscoveryAgent (hermes-lead-discovery-agent.ts) — the real
//      Lead Discovery ORCHESTRATOR. This is the thing that actually owns
//      the workflow below: it decides to plan queries, decides to search,
//      decides to extract, decides to review, decides to validate, and
//      decides what to do when any one of those steps comes back empty or
//      fails. TavilyDiscoveryProvider.discover() (below) now delegates to
//      it instead of containing that orchestration logic itself — a
//      production audit (2026-09) found the orchestration trapped inside
//      what was supposed to be just a search-provider class, with nothing
//      in the codebase actually playing the role "Hermes" implies.
//
// What model actually answers a given AI step depends on what that call is
// routed to and on each stage's own explicit routing decision below:
//
//   Business Badhao (campaigns/actions.ts / scheduled-pipeline.ts)
//     -> HermesLeadDiscoveryAgent.discover(criteria) — the orchestrator
//     -> HermesLeadDiscoveryAgent.planDiscoveryQueries: routes LEAD_DISCOVERY
//        to the "openrouter" provider first, explicitly requesting
//        NEMOTRON_MODEL there via modelByProvider (generateDiscoveryQueries
//        below) — not left to OpenRouterProvider's own implicit default, so
//        what this call intends is a named, checkable fact rather than an
//        assumption.
//        When openrouter's free-tier Nemotron endpoint is unavailable,
//        Hermes falls through to config.fallbackProvider
//        (AI_FALLBACK_PROVIDER) honestly and automatically — that
//        provider gets NO model override (modelByProvider names only
//        "openrouter"), so it requests its own configured default rather
//        than being asked for a Nemotron model id it doesn't have. Every
//        call records both what was requested (requestedProvider/
//        requestedModel) and what actually served it (provider/model) on
//        agent_runs.output, plus usedFallback — never silently and never
//        mislabeled as Nemotron in what gets stored. A live production
//        audit (2026-09) found the fallback firing on 60-90% of real
//        Reasoner/Analyst calls on this deployment's free-tier OpenRouter
//        quota — genuinely running on whatever config.fallbackProvider is
//        set to (Groq's openai/gpt-oss-120b in that deployment) rather
//        than Nemotron, honestly recorded as such. Check agent_runs for
//        the requested/actual ground truth for any real run. The call
//        itself is generateDiscoveryQueries below, turning the campaign/ICP
//        into real search queries.
//     -> HermesLeadDiscoveryAgent.runSearchProviders: Tavily, Exa on Tavily
//        failure (searchWithFallback, via the injected DiscoverySearchTool)
//        — real HTTP search, never an AI call.
//     -> HermesLeadDiscoveryAgent.extractCandidates: a second Hermes-routed
//        call, same explicit NEMOTRON_MODEL routing
//        (extractProspectsFromResults below), this time reasoning over the
//        actual SearchHit[] text, not the original prompt, returning its
//        raw candidates un-graded.
//     -> HermesLeadDiscoveryAgent.reviewCandidates -> the Independent
//        Hermes Reviewer (runFinalHermesValidation below) — a THIRD
//        Hermes-routed call, but this one passes an explicit model
//        override (INDEPENDENT_REVIEWER_MODEL) that forces a genuinely
//        different model — NousResearch's Hermes, not Nvidia's Nemotron —
//        reviewing the Analyst's own candidates against that same real
//        evidence and returning only the ones its own independent reading
//        judges are actually supported.
//     -> HermesLeadDiscoveryAgent.validateCandidates -> the Deterministic
//        Validator: finalizeDiscoveryResult below is the
//        safety net that runs on whatever the Reviewer accepted:
//        grounding/anti-fabrication/non-business/competitor filtering
//        (independent of, not replaced by, either AI stage above it),
//        dedup, the run cap, and assembling the DiscoveryResult — because
//        this codebase never trusts a model's own claim that it stayed
//        grounded, whichever model made that claim. Pure TypeScript, no
//        AI call and no external search — never anything else in between.
//        Runs unconditionally, even when the Reviewer itself timed out or
//        failed: runFinalHermesValidation degrades to handing back the
//        Analyst's own extracted candidates unreviewed rather than
//        discarding them (recorded honestly via
//        ProviderTelemetry.reviewerStatus/reviewerError) — this stage is
//        exactly why that is safe to do.
//     -> back to Business Badhao as this module's DiscoveryResult.
// Proven end-to-end (not just asserted) by discovery.call-graph.test.ts,
// which mocks only fetch and Supabase — never runHermesCompletion — so a
// change that broke the real routing, or that quietly made the Reviewer
// use the same model as the Analyst, would fail those tests.

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
  /**
   * Search queries already tried in an earlier batch of the SAME discovery
   * run (see runBatchedDiscovery, discovery-batch.ts) — asks the Reasoner
   * for genuinely different search angles instead of re-asking the same
   * handful of queries and re-finding the same (already cross-run-deduped)
   * businesses. Empty/unset for a normal single-pass call — the prompt is
   * unchanged in that case.
   */
  excludeQueries?: string[];
};

/**
 * Per-run record of which search provider actually did the work, and where
 * candidates were lost between extraction and persistence. Persisted into
 * agent_runs.output so a completed run can always be shown to have used a
 * real provider, and so a disappointing run can be explained without
 * re-instrumenting the code. Counts only — never keys or page content.
 */
export type ProviderTelemetry = {
  tavily: { requests: number; succeeded: number; failed: number; results: number };
  exa: { requests: number; succeeded: number; failed: number; results: number };
  /** Queries whose results came from Exa because Tavily failed for that query. */
  servedByExa: string[];
  extracted: number;
  /** How many of Nemotron's extracted candidates the final Hermes validation call was asked to review. */
  finalValidationInput: number;
  /**
   * How many candidates proceeded into the Deterministic Validator next —
   * still subject to its grounding/anti-fabrication check regardless of how
   * this number was reached. When reviewerStatus is "ok" this is genuinely
   * how many the Reviewer accepted; when reviewerStatus is "failed" this is
   * every extracted candidate, unreviewed (see reviewerStatus's own doc
   * comment) — never silently indistinguishable between the two, which is
   * exactly what reviewerStatus is for.
   */
  finalValidationAccepted: number;
  /**
   * Whether the Independent Hermes Reviewer stage actually produced a real,
   * independent review of this batch's extracted candidates before they
   * reached the Deterministic Validator.
   * - "ok": the Reviewer (its primary or named fallback model — see
   *   callIndependentReviewer) answered and parsed; its own accepted list
   *   is what proceeded into finalizeDiscoveryResult.
   * - "failed": both Reviewer attempts failed, timed out, or returned a
   *   response that could not be parsed — see reviewerError. This is a
   *   real, recorded degradation, never silently treated as "ok": a run can
   *   still succeed with real, grounded leads (finalizeDiscoveryResult runs
   *   unchanged either way, on the unreviewed extracted candidates), but
   *   without the Reviewer's additional, genuinely-different-model opinion
   *   on top of Nemotron's own extraction.
   * - "skipped": there were zero extracted candidates to review, so the
   *   Reviewer was never called — an LLM call over nothing can only ever
   *   return nothing.
   */
  reviewerStatus: "ok" | "failed" | "skipped";
  /** Set only when reviewerStatus is "failed" — the real error from the Reviewer's last attempt (network/timeout/provider error, or an unparseable response), for diagnosing a recurring issue. Always null otherwise. */
  reviewerError: string | null;
  rejectedNotGrounded: number;
  rejectedNotABusiness: number;
  rejectedCompetitor: number;
  verified: number;
};

export function newTelemetry(): ProviderTelemetry {
  return {
    tavily: { requests: 0, succeeded: 0, failed: 0, results: 0 },
    exa: { requests: 0, succeeded: 0, failed: 0, results: 0 },
    servedByExa: [],
    extracted: 0,
    finalValidationInput: 0,
    finalValidationAccepted: 0,
    reviewerStatus: "skipped",
    reviewerError: null,
    rejectedNotGrounded: 0,
    rejectedNotABusiness: 0,
    rejectedCompetitor: 0,
    verified: 0,
  };
}

export type DiscoveryResult =
  // `telemetry` is optional so pre-existing callers and tests are unaffected.
  | { ok: true; prospects: DiscoveredProspect[]; queriesRun: string[]; queriesFailed: string[]; telemetry?: ProviderTelemetry }
  | { ok: false; code: "not_configured" | "provider_error"; message: string; telemetry?: ProviderTelemetry };

export interface DiscoveryProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** trackingClient: see TrackingClient's own doc comment above. */
  discover(criteria: DiscoveryCriteria, trackingClient?: TrackingClient): Promise<DiscoveryResult>;
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

YOUR JOB IS TO FIND PAGES THAT NAME REAL, INDIVIDUAL BUSINESSES. A business that needs what the seller offers almost never publishes that need, so searching for the need itself ("small business with an outdated website") returns blog posts with no company in them. Instead, search the way you would to build a list of companies: the kind of business plus its location, aimed at sources that carry per-company entries — business directories and registries with individual company listings, local/maps-style business listings, chamber-of-commerce and trade-association member lists, and industrial-estate or market-area business listings.

Aim AWAY from these, they are where bad leads come from:
- "top 10 / best <industry>" blog roundups and news articles — they name a handful of famous corporations, not the ordinary local businesses the ICP describes.
- course catalogues, training-programme listings, job boards and admission pages — these list courses and vacancies, not companies that could buy anything.
- pages about an industry rather than pages listing its businesses.

If the ICP describes small or medium businesses, favour local and sector directories over anything that ranks or celebrates the biggest companies; word queries as a person building a prospect list would ("<industry> in <area> directory listings", "<industry> businesses <locality> contact"), never as a person shopping for the best provider.

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

export async function generateDiscoveryQueries(
  criteria: DiscoveryCriteria,
  trackingClient?: TrackingClient
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
    ...(criteria.excludeQueries && criteria.excludeQueries.length > 0
      ? [
          "",
          "=== QUERIES ALREADY TRIED — do not repeat these or near-duplicates of them ===",
          "This is a later batch of the same discovery run. The queries below already ran; produce genuinely different search angles (different source types, different concrete sub-industries or areas within the ICP, different phrasing) rather than rewording one of these.",
          ...criteria.excludeQueries.map((q) => `- ${q}`),
        ]
      : []),
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: criteria.organizationId,
    agentType: "lead_discovery_query_generation",
    taskType: "LEAD_DISCOVERY",
    systemPrompt: QUERY_SYSTEM_PROMPT,
    userPrompt,
    // Explicit Nemotron routing on openrouter only — a genuine fallback to
    // config.fallbackProvider still requests THAT provider's own default
    // model, never this one's id (see modelByProvider's doc comment in
    // hermes-service.ts). Recorded honestly either way via
    // requestedProvider/requestedModel on agent_runs.output.
    modelByProvider: { openrouter: NEMOTRON_MODEL },
    // NEMOTRON_MODEL's own published spec (openrouter.ai/api/v1/models)
    // lists supported_efforts: ["medium", "high"] — "low" (OpenRouterProvider's
    // own default) isn't one of them, so it was being silently ignored and
    // this model reasoned at its own default ("high") instead, taking long
    // enough to routinely miss this call's timeout and fall back to Groq —
    // confirmed via agent_runs telemetry (2026-09) showing requestedModel
    // staying Nemotron while the actual served model was Groq's every time.
    // "medium" is the lowest level this specific model actually honors.
    reasoningEffort: "medium",
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
    client: trackingClient,
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

export type SearchHit = { title: string; url: string; content: string };

const TAVILY_URL = "https://api.tavily.com/search";

export async function tavilySearch(
  query: string,
  apiKey: string,
  telemetry?: ProviderTelemetry
): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }> {
  if (telemetry) telemetry.tavily.requests += 1;
  let response: Response;
  try {
    response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: "basic" }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    if (telemetry) telemetry.tavily.failed += 1;
    return { ok: false, message: `Search failed for "${query}": ${cause instanceof Error ? cause.message : "network error"}` };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    if (telemetry) telemetry.tavily.failed += 1;
    return { ok: false, message: `Search failed for "${query}": HTTP ${response.status} ${bodyText.slice(0, 200)}` };
  }

  let data: { results?: { title?: string; url?: string; content?: string }[] };
  try {
    data = await response.json();
  } catch {
    if (telemetry) telemetry.tavily.failed += 1;
    return { ok: false, message: `Search for "${query}" returned a response that could not be parsed.` };
  }

  const results = (data.results ?? [])
    .filter((r): r is { title: string; url: string; content?: string } => Boolean(r.title && r.url))
    .map((r) => ({ title: r.title, url: r.url, content: r.content ?? "" }));

  if (telemetry) {
    telemetry.tavily.succeeded += 1;
    telemetry.tavily.results += results.length;
  }

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

export async function exaSearch(
  query: string,
  apiKey: string,
  telemetry?: ProviderTelemetry
): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }> {
  if (telemetry) telemetry.exa.requests += 1;
  let response: Response;
  try {
    response = await fetch(EXA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults: 5, contents: { text: true } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    if (telemetry) telemetry.exa.failed += 1;
    return { ok: false, message: `Exa search failed for "${query}": ${cause instanceof Error ? cause.message : "network error"}` };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    if (telemetry) telemetry.exa.failed += 1;
    return { ok: false, message: `Exa search failed for "${query}": HTTP ${response.status} ${bodyText.slice(0, 200)}` };
  }

  let data: { results?: { title?: string; url?: string; text?: string }[] };
  try {
    data = await response.json();
  } catch {
    if (telemetry) telemetry.exa.failed += 1;
    return { ok: false, message: `Exa search for "${query}" returned a response that could not be parsed.` };
  }

  const results = (data.results ?? [])
    .filter((r): r is { title: string; url: string; text?: string } => Boolean(r.title && r.url))
    .map((r) => ({ title: r.title, url: r.url, content: r.text ?? "" }));

  if (telemetry) {
    telemetry.exa.succeeded += 1;
    telemetry.exa.results += results.length;
  }

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
export async function searchWithFallback(
  query: string,
  tavilyApiKey: string,
  exaApiKey: string | undefined,
  telemetry?: ProviderTelemetry
): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }> {
  const tavilyResult = await tavilySearch(query, tavilyApiKey, telemetry);
  if (tavilyResult.ok) return tavilyResult;
  if (!exaApiKey) return tavilyResult;

  const exaResult = await exaSearch(query, exaApiKey, telemetry);
  if (exaResult.ok) {
    if (telemetry) telemetry.servedByExa.push(query);
    return exaResult;
  }

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

Many results are directory pages, local listings or association member lists. These are valuable SOURCES: extract the individually named businesses the page lists, as separate entries, all citing that page's URL. Extract the businesses being listed, never the site doing the listing, and never invent one. Skip a result that names no identifiable company at all.

EVERY ENTRY MUST BE AN ACTUAL ORGANISATION that could become a customer — a company, firm, shop, clinic, factory, school, hotel, practice or similar trading entity with a name. The following are NOT businesses and must never be extracted, even though directory pages are full of them:
- a course, class, training programme, certification, degree or syllabus ("Advanced Excel Course Noida", "SAP FICO Training") — a course is not a company, though the institute that runs it may be.
- a product, service, package or price plan.
- a job posting, vacancy or admission notice.
- a page title, article heading, section heading or category label ("Top 10 IT Companies in Noida", "Manufacturing Companies — Uttar Pradesh").
- the directory, portal, blog or association whose page you are reading.
If you cannot tell whether a name is a company or one of the above, leave it out.

USE THE SELLER CONTEXT FOR RELEVANCE, NOT AS A SEARCH TARGET. It tells you what this business sells, its products/services, its value proposition and the kinds of customer it serves. Use it to judge whether a discovered business is a plausible customer for that offering, and to recognise a rival. It never names a company to extract — the seller is not a prospect, and nothing in that section may be emitted as a business.

NEVER INCLUDE A COMPETITOR. If a business supplies what the seller sells — an agency, studio, firm, consultancy or freelancer in the seller's own or an adjacent field — it is a rival, not a customer, no matter how well it fits the location or size. Read the result's own description of the business before including it: a company described as an agency, studio or provider of the seller's service must be skipped. The only exception is when the ICP's targetCustomer / industry / businessType explicitly asks for those providers.

APPLY THE ICP BEFORE INCLUDING A BUSINESS. Skip any business that plainly contradicts it: outside the ICP's location, in an industry the ICP excludes, or matching any of the ICP's disqualifiers. Respect the ICP's company size — when it asks for small or medium businesses, do not include large enterprises, multinationals or household-name corporations; those are the wrong buyer even though directories list them prominently. Skip a business whose scale is obviously far outside what the ICP describes.

Take at most 3 businesses from any single result, choosing the ones that best fit the ICP, and spread your entries across the different results rather than exhausting the first one. If the same company appears under variant names ("TCS" and "Tata Consultancy Services"), emit it once under its fullest name.

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
// names we are there to collect. The completion budget matters just as much
// now that one page can yield a dozen entries — a production run finished
// with finish_reason "length", having spent the whole budget on the first
// listing page and never reaching the other queries' results, which is why
// output is weighted over input here. The whole request still sits under
// the 8k window.
const MAX_RESULTS_SENT_TO_EXTRACTION = 10;
const RESULT_EXCERPT_CHARS = 600;
/**
 * Hard ceiling on how many prospects one discover() call can return, applied
 * after dedup. The query count (3-5, DiscoveryQueriesSchema), results-per-
 * query (5, tavilySearch/exaSearch) and "at most 3 per result" extraction
 * instruction already keep a run small in practice — every real run so far
 * has returned well under this — but none of those are a code-enforced
 * ceiling on the final list, so this is the actual backstop against a run
 * that legitimately finds an unusually large number of distinct businesses
 * turning into an unbounded batch of prospects/leads persisted downstream.
 */
const MAX_PROSPECTS_PER_RUN = 20;
/** Seller-offering context is capped so adding it cannot push the request over the per-minute allowance. */
const SELLER_CONTEXT_CHARS = 900;
const EXTRACTION_MAX_TOKENS = 4000;

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
/**
 * Names that are plainly not a trading organisation. This is a backstop
 * under the extraction prompt's own rule, for the cases that leaked in
 * production: directory pages list courses, job posts and their own section
 * headings alongside real companies, and those were being persisted as
 * prospects. Deliberately narrow — it rejects only wording that cannot
 * belong to a company, so "SAS Base Training Institute" (an organisation)
 * survives while "Advanced SAS Base Training Course" does not.
 */
const NON_BUSINESS_NAME_PATTERNS: RegExp[] = [
  /\b(course|courses|classes|tutorial|tutorials|certification|certifications|syllabus|curriculum|internship|admissions?|scholarship|webinar)\b/i,
  /^(top|best)\b.*\b(in|near)\b/i,
  /^\d+\s+(top|best|leading)\b/i,
  /^(list|directory|category|index)\s+of\b/i,
  /^how to\b/i,
  /\b(job|jobs|vacancy|vacancies|hiring|recruitment)\b/i,
];

export function isNonBusinessName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  return NON_BUSINESS_NAME_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** True when the "business" is really the site that published the listing (a directory extracting itself). */
export function isSourceSiteName(name: string, sourceUrl: string): boolean {
  const host = canonicalizeUrl(sourceUrl)?.split("/")[0];
  if (!host) return false;
  const hostWord = host.split(".")[0].toLowerCase();
  if (hostWord.length < 4) return false;
  const nameWords = queryTokens(name);
  return nameWords.length <= 3 && nameWords.some((word) => word === hostWord);
}

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

/**
 * The second Nemotron stage only: turns real search results into candidate
 * prospects. Returns them un-grounded, exactly as Nemotron produced them,
 * plus the real-hit index that stage needed to reason over — grounding,
 * anti-fabrication filtering, dedup, and assembling the final result is
 * finalizeDiscoveryResult's job below, not this function's.
 */
export async function extractProspectsFromResults(
  criteria: DiscoveryCriteria,
  searchesByQuery: { query: string; results: SearchHit[] }[],
  telemetry?: ProviderTelemetry,
  trackingClient?: TrackingClient
): Promise<
  { ok: true; candidates: DiscoveredProspect[]; realHitByCanonicalUrl: Map<string, SearchHit> } | { ok: false; message: string }
> {
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

  // What the seller offers, so relevance can be judged ("would this kind of
  // business plausibly buy this?") and rivals recognised. Truncated because
  // the whole request shares one per-minute token allowance with the search
  // results below. Offering only — selectDiscoveryContext has already
  // stripped the seller's contact details and geography.
  const sellerOffering = criteria.businessContext ? formatBusinessContext(criteria.businessContext) : null;

  const userPrompt = [
    "=== WHAT THIS BUSINESS SELLS (seller-side — for judging relevance only, never a company to extract) ===",
    sellerOffering ? truncate(sellerOffering, SELLER_CONTEXT_CHARS) : "No Business Knowledge is on file for this organization yet.",
    "",
    "=== IDEAL CUSTOMER PROFILE — the kind of BUYER wanted ===",
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
    // Same explicit Nemotron-on-openrouter-only routing, and the same
    // "medium" reasoning-effort correction, as query generation above —
    // see that call site's comments for why.
    modelByProvider: { openrouter: NEMOTRON_MODEL },
    reasoningEffort: "medium",
    // Balances the two opposite failures seen in production: too low and a
    // reasoning model runs out mid-JSON (Groq HTTP 400 json_validate_failed);
    // too high and prompt + reserved completion tokens blow the 8k TPM
    // allowance (Groq HTTP 413). Together with the capped prompt above this
    // keeps the whole request comfortably inside that budget.
    maxTokens: EXTRACTION_MAX_TOKENS,
    temperature: 0.2,
    responseFormat: "json",
    client: trackingClient,
  });

  if (!result.ok) return { ok: false, message: result.message };

  const parsed = parseAiJson(result.text, ExtractionResponseSchema);
  if (!parsed.ok) return { ok: false, message: "Could not extract prospects from search results — please try again." };

  if (telemetry) telemetry.extracted = parsed.data.prospects.length;

  return { ok: true, candidates: parsed.data.prospects, realHitByCanonicalUrl };
}

// ---------------------------------------------------------------------------
// Step 4 (AI, GENUINELY INDEPENDENT of the Nemotron calls above): the
// Independent Hermes Reviewer. This is not "Hermes" as a label on another
// Nemotron call — it is a real, different model. The two calls above this
// one (generateDiscoveryQueries, extractProspectsFromResults) each request
// NEMOTRON_MODEL explicitly, but only ON OPENROUTER — via modelByProvider
// (hermes-service.ts), which lets a genuine cross-provider fallback still
// request that OTHER provider's own default model rather than being asked
// for Nemotron's id. This call is different in kind, not just degree: it
// passes an explicit model override (INDEPENDENT_REVIEWER_MODEL, below) —
// via `model`, not `modelByProvider` — all the way down to the real HTTP
// request body, so it runs on a NousResearch model — a different company's
// model, different weights, different training — reachable through the
// same already-configured OpenRouter credentials (no new service, no
// invented API, no new credential: OPENROUTER_API_KEY is what authorizes
// this call too).
//
// modelProviders: ["openrouter"] (passed at both call sites below) is
// deliberate, not incidental: a production incident (see
// INDEPENDENT_REVIEWER_MODEL's own comment) showed that without it, Hermes
// service's normal LEAD_DISCOVERY routing chain would retry this same
// OpenRouter-only model id against Groq next — which has no such model at
// all — turning one real outage into a guaranteed second failure instead
// of an actual fallback. Restricting to OpenRouter, and falling back to a
// second, different OpenRouter-hosted Hermes model instead (see
// runFinalHermesValidation), is what makes this a real, deterministic
// fallback chain rather than a doomed retry. This is why the Reviewer uses
// `model`+`modelProviders` (an all-or-nothing restriction: only these
// provider(s), only this model, no cross-provider substitution at all)
// rather than `modelByProvider` (the Nemotron calls' mechanism: an explicit
// model on named provider(s), with any other provider in the chain still
// free to fall back to its own default) — the two stages have genuinely
// different fallback needs, not an inconsistency between them.
//
// Its output is still not trusted blindly: finalizeDiscoveryResult runs
// unchanged immediately afterward, re-checking every candidate this stage
// accepts against realHitByCanonicalUrl exactly as it would Nemotron's raw
// output. This stage can only narrow the candidate list, never widen it —
// it has no access to anything beyond the candidates and evidence it was
// given, so it cannot introduce a business, URL, or fact the search never
// produced. And because it is a genuinely different model, a mistake
// specific to Nemotron's own reasoning is not guaranteed to be repeated
// here — the two calls do not share failure modes the way two calls to the
// same model reviewing its own output would.
// ---------------------------------------------------------------------------

/**
 * NousResearch's Hermes 3 (Llama-3.1 70B) on OpenRouter — a real, distinct,
 * currently-listed model (openrouter.ai/models), unrelated to Nvidia's
 * Nemotron and to whatever Groq model LEAD_DISCOVERY's own fallback may be
 * serving elsewhere in this same run.
 *
 * Was "nousresearch/hermes-4-70b" until a live production incident: that
 * model id is still listed in OpenRouter's catalog, but its one serving
 * endpoint (Nebius) was confirmed, via OpenRouter's own public
 * /api/v1/models/{id}/endpoints response, to have 0% uptime over the
 * preceding 24h — not a renamed/deprecated model id, a dead backend behind
 * a still-valid id. That silently starved every discovery run of a working
 * Reviewer for several days (agent_runs/model_usage show zero successful
 * lead_discovery_hermes_review calls and zero new leads across that
 * window). Replaced with this model after confirming, the same way, that
 * its endpoint (DeepInfra) was reporting 100% uptime over both the
 * preceding 24h and the preceding 30 minutes.
 *
 * Deliberately hardcoded rather than left to OPENROUTER_MODEL/the routing
 * table: this stage's entire purpose is model independence from whatever
 * the rest of LEAD_DISCOVERY is configured to use, so it must not silently
 * become the same model as the calls it's reviewing just because an env
 * var changed.
 */
const INDEPENDENT_REVIEWER_MODEL = "nousresearch/hermes-3-llama-3.1-70b";

/**
 * Deterministic, explicit second attempt if the primary Reviewer model's
 * own endpoint is ever down the same way — a second real, distinct,
 * OpenRouter-hosted Hermes model (confirmed 100% uptime alongside the
 * primary above), never the Analyst's own model or a different provider.
 * Tried at most once; if this also fails, runFinalHermesValidation fails
 * honestly (see its own doc comment) rather than fabricating a review.
 */
const INDEPENDENT_REVIEWER_FALLBACK_MODEL = "nousresearch/hermes-4-405b";

/**
 * The Reviewer's models are much larger than most Hermes-routed calls (up to
 * 405B) and this call's own maxTokens budget is 4000 — comfortably past the
 * platform-wide 20s default (config.timeoutMs) under real generation load.
 *
 * Raised once already, from the 20s platform default to 40s, after a
 * 2026-09-07 incident where both attempts aborted right around 20s while
 * still generating — because the abort landed mid body-read rather than on
 * the initial request, that surfaced as a misleading "malformed_response
 * ... raw body (empty)" instead of the real "timeout" (see the body-read fix
 * in src/lib/ai/providers/openai-compatible.ts).
 *
 * Raised again here, to 60s, after real production telemetry (2026-09-07
 * 19:38 and 2026-09-08 19:06 UTC) showed the Reviewer still timing out at
 * exactly 40,000ms under real load on these same large models. Raising the
 * number alone is not the actual fix for a model that is occasionally just
 * slow — at any finite value, a genuine outage would still eventually time
 * out — so this is a modest, evidence-based increase, not the safety net:
 * see runFinalHermesValidation's own doc comment for that (a Reviewer
 * timeout/failure no longer discards this batch's already-grounded
 * candidates; it only means they proceed to the Deterministic Validator
 * without the Reviewer's additional opinion on top). 60s stays a small
 * fraction of both the manual Start Discovery action's own budget (270s,
 * see TOTAL_REQUEST_BUDGET_MS in campaigns/actions.ts) and the scheduled
 * pipeline's (240s, scheduled-pipeline.ts) — two failed attempts in a row
 * (see callIndependentReviewer) costs at most 120s, still well inside
 * either. This override doesn't change the platform default for any other
 * Hermes-routed call.
 */
const INDEPENDENT_REVIEWER_TIMEOUT_MS = 60_000;

const FinalValidationSchema = z.object({ accepted: z.array(ExtractedProspectSchema) });

const FINAL_VALIDATION_SYSTEM_PROMPT = `You are an independent reviewer auditing candidate prospect businesses before they are saved. A separate AI system already extracted these candidates from real web search results — you did not produce them and you are not that system. Your job is to independently verify each candidate against the same real evidence, as a genuine second opinion, not a formality.

Do not trust a candidate simply because the previous system produced it. It may have hallucinated a fact, mis-cited a URL, or accepted a business that does not actually belong. Independently verify every candidate against the supplied evidence as if you had never seen its conclusions before.

You are given: the campaign's Ideal Customer Profile, the REAL SEARCH EVIDENCE (numbered real results — title, URL, content excerpt — this is the only ground truth), and the CANDIDATE PROSPECTS the previous system proposed from that evidence.

THE SEARCH EVIDENCE IS AUTHORITATIVE. You are not searching or inventing anything — you are independently auditing candidates that already exist against evidence that already exists.

Reject a candidate if:
- its sourceUrl is not one of the numbered real evidence URLs given to you (never accept a URL you don't see listed, and never construct or guess one)
- its evidenceSnippet or claimed facts (location, industry, business type) are not actually supported by that URL's real content — the previous system may have hallucinated or overstated this
- it is not a real trading organisation — a course, job posting, product listing, page heading, or the directory/portal site itself, not a company
- it is a competitor — a business that itself supplies what the seller in this campaign sells (an agency, studio, firm, consultancy or freelancer in the seller's own or an adjacent field) — unless the ICP's targetCustomer/industry/businessType explicitly asks for such providers
- it plainly contradicts the ICP (wrong location, excluded industry, matches a stated disqualifier, or is far outside the ICP's stated company size)
- it appears to be a duplicate of another candidate in the list (same business under a slightly different name or URL)

Accept a candidate only when your own independent reading of the evidence supports it. When you accept one, keep its fields as given, except you may trim evidenceSnippet to only the part actually supported by the cited URL's content — never add a claim the content doesn't make.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly this key:
{ "accepted": [ { "companyName": string, "website": string | null, "location": string | null, "industry": string | null, "businessType": string | null, "email": string | null, "phone": string | null, "matchedIcpCriteria": string[], "evidenceSnippet": string, "sourceUrl": string, "searchQuery": string } ] }

If none of the candidates hold up under your own independent review, return { "accepted": [] } — never accept a candidate to avoid an empty result.`;

/** Same excerpt/result-count budget as the extraction call above — this call sends the same evidence again. */
const FINAL_VALIDATION_MAX_TOKENS = EXTRACTION_MAX_TOKENS;

/**
 * Calls the Independent Reviewer, trying INDEPENDENT_REVIEWER_MODEL first
 * and INDEPENDENT_REVIEWER_FALLBACK_MODEL exactly once if that fails — a
 * fixed, two-entry chain, never an open-ended retry, and never a provider
 * or model this stage doesn't explicitly name. modelProviders: ["openrouter"]
 * on both attempts is what makes this a real fallback rather than the
 * production incident this replaced: neither model id exists on any other
 * configured provider, so letting the normal routing chain retry them
 * elsewhere would only spend a call on a guaranteed second failure.
 *
 * Both attempts are real, separately tracked runHermesCompletion calls —
 * each gets its own honestly-recorded agent_runs/model_usage row (actual
 * provider, actual model, actual outcome) via the exact same tracking every
 * other Hermes call already goes through; nothing here is fabricated or
 * merged after the fact. If both fail, the caller (runFinalHermesValidation)
 * fails the same way a single failed attempt always did.
 */
async function callIndependentReviewer(
  organizationId: string | null,
  systemPrompt: string,
  userPrompt: string,
  trackingClient?: TrackingClient
): Promise<HermesResult> {
  const primary = await runHermesCompletion({
    organizationId,
    agentType: "lead_discovery_hermes_review",
    taskType: "LEAD_DISCOVERY",
    model: INDEPENDENT_REVIEWER_MODEL,
    modelProviders: ["openrouter"],
    systemPrompt,
    userPrompt,
    maxTokens: FINAL_VALIDATION_MAX_TOKENS,
    temperature: 0.1,
    responseFormat: "json",
    timeoutMs: INDEPENDENT_REVIEWER_TIMEOUT_MS,
    client: trackingClient,
  });
  if (primary.ok) return primary;

  return runHermesCompletion({
    organizationId,
    agentType: "lead_discovery_hermes_review",
    taskType: "LEAD_DISCOVERY",
    model: INDEPENDENT_REVIEWER_FALLBACK_MODEL,
    modelProviders: ["openrouter"],
    systemPrompt,
    userPrompt,
    maxTokens: FINAL_VALIDATION_MAX_TOKENS,
    temperature: 0.1,
    responseFormat: "json",
    timeoutMs: INDEPENDENT_REVIEWER_TIMEOUT_MS,
    client: trackingClient,
  });
}

/** Always ok:true — see runFinalHermesValidation's own doc comment for why a Reviewer failure is a degradation, never a hard failure. */
export type FinalHermesValidationResult = {
  ok: true;
  candidates: DiscoveredProspect[];
  reviewerStatus: "ok" | "failed" | "skipped";
  reviewerError: string | null;
};

/**
 * The Independent Hermes Reviewer: a real call to a genuinely different
 * model (see INDEPENDENT_REVIEWER_MODEL above) than the Nemotron calls
 * above it, reviewing those calls' own extracted candidates against the
 * exact same real evidence they were extracted from. Skips the call
 * entirely when there is nothing to review — an LLM call over zero
 * candidates can only ever return zero candidates, so making it would just
 * spend budget to learn nothing, the same reasoning already applied to
 * skipping extraction when a search returns zero hits (see discover()
 * below).
 *
 * Resilient to a Reviewer failure/timeout BY DESIGN: this function always
 * returns ok:true. A failure of both Reviewer attempts (network error,
 * timeout, rate limit — see callIndependentReviewer) or a response that
 * cannot be parsed is never treated as a reason to throw away candidates
 * that Nemotron's own extraction step already grounded in real search
 * evidence — production telemetry (2026-09-07, 2026-09-08) showed exactly
 * this happening: a Reviewer timeout discarding a whole batch of otherwise
 * real, grounded candidates. Instead it degrades to `reviewerStatus:
 * "failed"` and hands the unreviewed extracted candidates straight through.
 *
 * This is safe specifically because finalizeDiscoveryResult (the
 * Deterministic Validator) runs immediately after this, on every path,
 * unconditionally — it already re-checks each candidate's URL/evidence
 * grounding and re-applies the competitor/non-business filters completely
 * independently of whether the Reviewer ever ran (it was never written to
 * trust the Reviewer's approval as sufficient on its own). A missing
 * Reviewer opinion removes one of two independent checks, never the only
 * one — the deterministic grounding check that follows is never bypassed.
 *
 * Never silently fabricates or hides a review: reviewerStatus/reviewerError
 * on the telemetry record exactly what happened, so a degraded run's leads
 * are never indistinguishable from ones a real independent model actually
 * reviewed (see ProviderTelemetry.reviewerStatus's own doc comment).
 */
export async function runFinalHermesValidation(
  criteria: DiscoveryCriteria,
  candidates: DiscoveredProspect[],
  realHitByCanonicalUrl: Map<string, SearchHit>,
  telemetry?: ProviderTelemetry,
  trackingClient?: TrackingClient
): Promise<FinalHermesValidationResult> {
  if (candidates.length === 0) {
    if (telemetry) telemetry.reviewerStatus = "skipped";
    return { ok: true, candidates: [], reviewerStatus: "skipped", reviewerError: null };
  }

  if (telemetry) telemetry.finalValidationInput = candidates.length;

  const evidenceText = [...realHitByCanonicalUrl.values()]
    .map((hit, i) => `Result ${i + 1}: "${hit.title}"\nURL: ${hit.url}\nContent: ${truncate(hit.content, RESULT_EXCERPT_CHARS)}`)
    .join("\n\n");

  const userPrompt = [
    "=== IDEAL CUSTOMER PROFILE ===",
    JSON.stringify(criteria.icpCriteria),
    "",
    "=== REAL SEARCH EVIDENCE (the only ground truth — every accepted candidate must cite one of these URLs) ===",
    evidenceText || "(no evidence)",
    "",
    "=== CANDIDATE PROSPECTS TO REVIEW (produced by a separate system — verify independently, do not just trust them) ===",
    JSON.stringify(candidates),
  ].join("\n");

  const result = await callIndependentReviewer(criteria.organizationId, FINAL_VALIDATION_SYSTEM_PROMPT, userPrompt, trackingClient);

  if (!result.ok) {
    // Degrade, don't discard — see this function's own doc comment. These
    // candidates were never actually reviewed, so they are recorded as the
    // Reviewer having failed, not as it having "accepted" them — but they
    // are exactly what the Deterministic Validator receives next.
    if (telemetry) {
      telemetry.reviewerStatus = "failed";
      telemetry.reviewerError = result.message;
      telemetry.finalValidationAccepted = candidates.length;
    }
    return { ok: true, candidates, reviewerStatus: "failed", reviewerError: result.message };
  }

  const parsed = parseAiJson(result.text, FinalValidationSchema);
  if (!parsed.ok) {
    // The Reviewer answered, but not usably — the same underlying problem
    // as an outright call failure (no real, trustworthy independent opinion
    // to act on), so the same degrade-gracefully treatment applies.
    const message = "Independent Hermes Reviewer returned a response that could not be validated.";
    if (telemetry) {
      telemetry.reviewerStatus = "failed";
      telemetry.reviewerError = message;
      telemetry.finalValidationAccepted = candidates.length;
    }
    return { ok: true, candidates, reviewerStatus: "failed", reviewerError: message };
  }

  if (telemetry) {
    telemetry.reviewerStatus = "ok";
    telemetry.finalValidationAccepted = parsed.data.accepted.length;
  }

  return { ok: true, candidates: parsed.data.accepted, reviewerStatus: "ok", reviewerError: null };
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
// Deterministic safety net: runs on whatever runFinalHermesValidation
// accepted, not because that stage is trusted, but because it explicitly
// isn't — this codebase never trusts a model's own claim that it stayed
// grounded, whichever call made that claim. Reject anything not actually
// grounded in a real search result, filter non-businesses and competitors
// again independently, deduplicate, cap the run size, and assemble the
// DiscoveryResult handed back to Business Badhao's persistence pipeline.
// A candidate the final Hermes call accepted incorrectly (a citation to a
// URL it misread, a competitor it missed) is still caught here.
// ---------------------------------------------------------------------------

export function finalizeDiscoveryResult(
  criteria: DiscoveryCriteria,
  candidates: DiscoveredProspect[],
  realHitByCanonicalUrl: Map<string, SearchHit>,
  queriesRun: string[],
  queriesFailed: string[],
  telemetry: ProviderTelemetry
): DiscoveryResult {
  const sellerTokens = sellerOfferingTokens(criteria);
  const grounded: DiscoveredProspect[] = [];

  for (const prospect of candidates) {
    const companyName = prospect.companyName.trim();

    // Must actually be a business, not a course/job/heading, and not the
    // directory that published the page.
    if (isNonBusinessName(companyName) || isSourceSiteName(companyName, prospect.sourceUrl)) {
      telemetry.rejectedNotABusiness += 1;
      continue;
    }

    // Backstop under the extraction prompt's competitor rule: a company
    // whose own name advertises it as a supplier of what we sell ("… Web
    // Design Studio") is a rival, not a buyer. Name only — evidence text
    // mentions words like "agency" far too incidentally to judge on.
    if (!icpTargetsProviders(criteria.icpCriteria) && isCompetitorSeekingQuery(companyName, sellerTokens)) {
      telemetry.rejectedCompetitor += 1;
      continue;
    }

    // Anti-fabrication guard: drop anything citing a URL that wasn't
    // actually in the search results — Nemotron is not trusted to have
    // cited real evidence just because it was instructed to. Anything that
    // survives is rewritten to carry the provider's own URL and, when the
    // model's quote can't be found in the real page text, the provider's
    // own excerpt — so a stored prospect's source and evidence always come
    // from the actual search result rather than from the model's
    // rendering of it.
    const canonical = canonicalizeUrl(prospect.sourceUrl);
    const realHit = canonical ? realHitByCanonicalUrl.get(canonical) : undefined;
    if (!realHit) {
      telemetry.rejectedNotGrounded += 1;
      continue;
    }

    const quote = prospect.evidenceSnippet.trim();
    const quoteIsReal = quote.length > 0 && realHit.content.includes(quote);

    grounded.push({
      ...prospect,
      companyName,
      sourceUrl: realHit.url,
      evidenceSnippet: quoteIsReal || !realHit.content ? quote : truncate(realHit.content, 300),
    });
  }

  telemetry.verified = grounded.length;

  return {
    ok: true,
    prospects: dedupeProspects(grounded).slice(0, MAX_PROSPECTS_PER_RUN),
    queriesRun,
    queriesFailed,
    telemetry,
  };
}

// ---------------------------------------------------------------------------
// Real search tool: Tavily search (with Exa as its own same-query fallback),
// gated entirely behind TAVILY_API_KEY. This class has exactly one job —
// answer one query with real results — and no orchestration logic of its
// own. It implements DiscoverySearchTool (hermes-lead-discovery-agent.ts),
// which is what HermesLeadDiscoveryAgent actually calls; it also still
// implements DiscoveryProvider for backward-compatible callers
// (discovery-batch.ts's getDiscoveryProvider() consumer, and every existing
// test that constructs this class directly), by handing the real
// orchestration straight to the Hermes agent.
// ---------------------------------------------------------------------------

export class TavilyDiscoveryProvider implements DiscoveryProvider, DiscoverySearchTool {
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

  /**
   * The actual DiscoverySearchTool capability: one query in, real results
   * (or a real failure) out. No query planning, no extraction, no review,
   * no validation — those are HermesLeadDiscoveryAgent's job, not this
   * class's. Unchanged behavior from before this fix: still Tavily first,
   * Exa only on Tavily's own failure for this exact query
   * (searchWithFallback, untouched).
   */
  async search(
    query: string,
    telemetry?: ProviderTelemetry
  ): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      return { ok: false, message: "Lead discovery isn't connected to a search provider yet — TAVILY_API_KEY is not set." };
    }
    return searchWithFallback(query, apiKey, this.exaApiKey, telemetry);
  }

  async discover(criteria: DiscoveryCriteria, trackingClient?: TrackingClient): Promise<DiscoveryResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        code: "not_configured",
        message: "Lead discovery isn't connected to a search provider yet — TAVILY_API_KEY is not set.",
      };
    }

    // The real orchestrator. See HermesLeadDiscoveryAgent's own doc comment
    // (hermes-lead-discovery-agent.ts) for why this class no longer contains
    // the plan -> search -> extract -> review -> validate sequence itself.
    return new HermesLeadDiscoveryAgent(this).discover(criteria, trackingClient);
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
