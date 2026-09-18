import "server-only";
import { z } from "zod";
import type { DiscoverySearchTool } from "@/lib/ai/agents/hermes-lead-discovery-agent";
import type { DiscoveryCriteria, ProviderTelemetry, SearchHit } from "@/lib/ai/agents/discovery";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";

/**
 * Instagram as a genuine, ADDITIVE lead-discovery source — completely
 * separate from src/lib/instagram/* (Meta Graph API OAuth + Business
 * Discovery), which only ever verifies a handle another source already
 * found and has no official capability to search Instagram at all (see
 * that module's own doc comments). Instagram publishes no API for
 * open-ended discovery by category/location/keyword; the only way to find
 * NEW businesses there is to actually browse it with an authenticated
 * session. This module is a thin, honest HTTP adapter to an already-
 * authorized, external browser-automation backend that does that browsing
 * on the operator's behalf — it never logs into Instagram itself, never
 * sees or stores an Instagram password or session cookie, and never runs a
 * browser inside this process or this deployment.
 *
 * Until that backend is configured (the two env vars below), this
 * contributes zero candidates and every other discovery source is
 * completely unaffected — the same silently-absent posture Exa already has
 * when EXA_API_KEY isn't set (see searchWithFallback in discovery.ts). This
 * deployment does not have that backend configured yet; the adapter below
 * is real and callable the moment it is — nothing here is mocked, and it
 * never fabricates a result.
 *
 * Configuration contract (deliberately generic, not tied to one vendor's
 * undocumented wire format): a single HTTP endpoint, authenticated with a
 * bearer token, that performs ONE authenticated Instagram browser search
 * per call and returns real, visible public profile data. In practice this
 * is expected to be a small operator-controlled proxy in front of a real
 * browser-automation service (e.g. one that drives an authorized Instagram
 * session), but this module has no opinion on what's behind the URL beyond
 * the JSON contract below — it never assumes a specific vendor's raw API
 * shape it hasn't been shown.
 *
 *   INSTAGRAM_DISCOVERY_API_URL  — full URL to POST to.
 *   INSTAGRAM_DISCOVERY_API_KEY  — bearer token for that URL. Never logged,
 *                                  never echoed in an error message, never
 *                                  sent anywhere except this one Authorization
 *                                  header.
 *
 * Request:  { "goal": string, "maxResults": number }
 * Response: { "results": [ { "url": string, "title": string, "content": string } ] }
 * — the exact same shape tavilySearch/exaSearch already produce, so it
 * plugs into the identical shared extraction/review/validation pipeline
 * with no translation layer.
 */

export function isInstagramDiscoveryConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_DISCOVERY_API_URL && process.env.INSTAGRAM_DISCOVERY_API_KEY);
}

/**
 * A real authenticated browser session (navigate, read, scroll) is far
 * slower than an API search call — bounded generously here, but still
 * bounded, so one slow/hung Instagram request can only ever cost this much
 * of the shared discovery batch budget (discovery-batch.ts's own
 * outOfTime), never hang the batch indefinitely.
 */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * An authenticated browser session is a slow, metered resource — asking it
 * to run once per Nemotron-planned query (there can be up to 5 in a single
 * batch) would spend a lot of it for little marginal benefit once the first
 * couple of queries have already characterized what's on Instagram for this
 * ICP. Bounds real browser work to the first N queries per discover() call;
 * every later call in the same batch returns a genuine, honest empty result
 * (never an error) rather than spending more of a slow/metered resource —
 * the same reasoning as contact-search.ts's own MAX_SEARCH_QUERIES cap.
 */
const MAX_QUERIES_PER_BATCH = 2;

const ResponseSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().min(1),
        title: z.string().min(1),
        content: z.string().default(""),
      })
    )
    .default([]),
});

/**
 * What the configured backend is told to look for — built from the SAME
 * DiscoveryCriteria every other search source already receives (see
 * generateDiscoveryQueries in discovery.ts): the Nemotron-planned query
 * (already ICP-grounded), the saved ICP, and Business Knowledge. Never a
 * second, parallel representation of either, and never a second
 * query-planning AI call — Instagram discovery reuses the exact queries
 * Nemotron already planned for the web search, adapted to a browsing
 * instruction rather than a search-engine string.
 */
function buildGoal(query: string, criteria: DiscoveryCriteria): string {
  const businessKnowledge = criteria.businessContext ? formatBusinessContext(criteria.businessContext) : null;

  return [
    "Using the authenticated Instagram account/session already configured for this integration, browse Instagram's own public web interface to find PUBLIC business/creator profiles matching the search below.",
    "Never open a private account. Never access anything beyond a profile's own public bio/info. Never attempt to bypass a login wall, CAPTCHA, or any other Instagram security control.",
    `Search intent: ${query}`,
    "",
    "=== IDEAL CUSTOMER PROFILE (for judging relevance only — not a literal search string) ===",
    JSON.stringify(criteria.icpCriteria),
    businessKnowledge ? `\n=== WHAT THE SEARCHING BUSINESS SELLS (for judging relevance only) ===\n${businessKnowledge}` : "",
    "",
    'Return up to 5 distinct matching profiles as JSON with exactly this shape: { "results": [ { "url": "<the profile\'s real instagram.com URL>", "title": "<display name and @handle exactly as shown on the profile>", "content": "<the bio, category, and any other genuinely visible public text on the profile>" } ] }.',
    "Only include information that is actually visible on the profile right now. Never invent a bio, category, location, follower count, or business detail that isn't genuinely shown. If nothing relevant is found, return { \"results\": [] } — never fabricate a result to avoid an empty one.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Real HTTP adapter — implements DiscoverySearchTool (hermes-lead-
 * discovery-agent.ts) so it plugs into HermesLeadDiscoveryAgent exactly
 * like TavilyDiscoveryProvider does, contributing SearchHit[] into the SAME
 * shared Nemotron extraction / Independent Hermes Reviewer / Deterministic
 * Validator pipeline — never a second, Instagram-specific quality gate.
 * Never throws: every outcome is the same typed {ok:true, results} /
 * {ok:false, message} shape tavilySearch/exaSearch already use, so a
 * caller (HermesLeadDiscoveryAgent.runSearchProviders) treats an Instagram
 * failure identically to a Tavily/Exa one — isolated to this one tool, this
 * one query, never propagated into aborting the batch.
 */
export class InstagramBrowserDiscoveryTool implements DiscoverySearchTool {
  readonly name = "instagram";
  private queriesRun = 0;

  /** One instance per discover() call (see TavilyDiscoveryProvider.discover), so this counter is a genuine per-batch bound, not a per-run or process-lifetime one. */
  constructor(private readonly criteria: DiscoveryCriteria) {}

  async search(query: string, telemetry?: ProviderTelemetry): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }> {
    if (this.queriesRun >= MAX_QUERIES_PER_BATCH) {
      // A genuine, honest "nothing more from this source this batch" — not a
      // failure. Tavily/Exa still search every planned query normally.
      return { ok: true, results: [] };
    }
    this.queriesRun += 1;

    const apiUrl = process.env.INSTAGRAM_DISCOVERY_API_URL;
    const apiKey = process.env.INSTAGRAM_DISCOVERY_API_KEY;
    if (!apiUrl || !apiKey) {
      return { ok: false, message: "Instagram discovery isn't connected to a browser-automation backend yet." };
    }

    if (telemetry) telemetry.instagramDiscovery.requests += 1;

    let response: Response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ goal: buildGoal(query, this.criteria), maxResults: 5 }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      if (telemetry) telemetry.instagramDiscovery.failed += 1;
      return { ok: false, message: `Instagram discovery failed for "${query}": ${cause instanceof Error ? cause.message : "network error"}` };
    }

    // Never echo the Authorization header/apiKey in any error message below —
    // only the response body, and only truncated, same posture as
    // tavilySearch/exaSearch's own error handling.
    const bodyText = await response.text().catch(() => "");

    if (!response.ok) {
      if (telemetry) telemetry.instagramDiscovery.failed += 1;
      return { ok: false, message: `Instagram discovery failed for "${query}": HTTP ${response.status} ${bodyText.slice(0, 200)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      if (telemetry) telemetry.instagramDiscovery.failed += 1;
      return { ok: false, message: `Instagram discovery for "${query}" returned a response that could not be parsed.` };
    }

    const validated = ResponseSchema.safeParse(parsed);
    if (!validated.success) {
      if (telemetry) telemetry.instagramDiscovery.failed += 1;
      return { ok: false, message: `Instagram discovery for "${query}" returned an unexpected shape.` };
    }

    const results: SearchHit[] = validated.data.results.map((r) => ({ title: r.title, url: r.url, content: r.content, source: "instagram" }));

    if (telemetry) {
      telemetry.instagramDiscovery.succeeded += 1;
      telemetry.instagramDiscovery.results += results.length;
    }

    return { ok: true, results };
  }
}
