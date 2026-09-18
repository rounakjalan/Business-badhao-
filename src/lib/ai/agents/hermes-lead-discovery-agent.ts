import {
  extractProspectsFromResults,
  finalizeDiscoveryResult,
  generateDiscoveryQueries,
  newTelemetry,
  runFinalHermesValidation,
  type DiscoveredProspect,
  type DiscoveryCriteria,
  type DiscoveryResult,
  type ProviderTelemetry,
  type SearchHit,
  type TrackingClient,
} from "@/lib/ai/agents/discovery";

/**
 * What the Hermes Lead Discovery Agent needs from a search source — nothing
 * more. A provider implementing this has no say over query generation,
 * extraction, review, or validation; it only answers one query with real
 * results (or a real failure). This is the seam a future provider (Google/
 * Web, or any other source) plugs into later without touching anything in
 * this file — `HermesLeadDiscoveryAgent` only ever calls `.search()`, never
 * anything source-specific.
 */
export interface DiscoverySearchTool {
  readonly name: string;
  search(
    query: string,
    telemetry?: ProviderTelemetry
  ): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }>;
}

/**
 * The Hermes Lead Discovery Agent — the real orchestrator of one discovery
 * round, not a label on a routing call.
 *
 * This class OWNS the control flow an audit (2026-09) found missing:
 * understanding the campaign + ICP, asking Nemotron to plan search queries,
 * running those queries against the injected search tool, asking Nemotron
 * to extract candidates from the real results, handing those candidates to
 * the Independent Hermes Reviewer, and running the Deterministic Validator
 * on whatever the Reviewer accepted (or, on a Reviewer failure, on the
 * unreviewed candidates — the Reviewer's own degrade-gracefully contract,
 * unchanged). Every step is a genuinely separate, named responsibility of
 * this class, not a single function body that happens to call several AI
 * stages in a row: discover() decides what happens after each stage
 * (stop on zero results, stop on total search failure, propagate a
 * degraded review, etc.) — that branching is what "orchestration" means
 * here, and it previously lived inside a class whose job was supposed to be
 * "call a search API" (TavilyDiscoveryProvider.discover), not "run the
 * Lead Discovery pipeline."
 *
 * runHermesCompletion (hermes-service.ts) remains shared AI infrastructure —
 * the generic routing/telemetry wrapper every AI feature in this app calls
 * through. It is NOT renamed, NOT removed, and NOT "the agent": it is a tool
 * this agent's planning/extraction steps use to actually talk to Nemotron
 * (via generateDiscoveryQueries/extractProspectsFromResults, which pin
 * NEMOTRON_MODEL explicitly — see discovery.ts), and that the Independent
 * Hermes Reviewer step uses to talk to a genuinely different, forced model
 * (see runFinalHermesValidation's own doc comment in discovery.ts for why
 * that independence is real, not nominal).
 *
 * Persistence, cross-run deduplication, and triggering Research are
 * deliberately NOT this class's job — they already have a single, correct,
 * well-tested implementation in discovery-batch.ts's runBatchedDiscovery
 * (cross-run dedupe-before-insert, persistDiscoveredProspect, the
 * onLeadPersisted hook into the Research worker pool). Duplicating that here
 * would be exactly the "second parallel lead creation implementation" this
 * fix is required not to create. This agent's contract ends at a validated,
 * within-run-deduped DiscoveryResult — runBatchedDiscovery is the caller
 * that turns that into real prospects/leads and immediate Research, exactly
 * as it already does.
 *
 * ADDITIVE second source (2026-09 investigation): `additionalSearchTools`
 * lets a second, independent DiscoverySearchTool contribute candidates
 * ALONGSIDE the primary tool for every planned query — never as a fallback
 * relationship between them (that stays Tavily→Exa, entirely inside the
 * primary tool's own .search()), and never gating one on the other's
 * success or failure. See runSearchProviders below for exactly how the two
 * are merged per query. Defaults to none, so every existing
 * `new HermesLeadDiscoveryAgent(tool)` call site behaves identically to
 * before this existed. This is real, tested, general-purpose orchestration
 * infrastructure — no concrete second-source implementation is wired into
 * this codebase today (see TavilyDiscoveryProvider.discover in discovery.ts
 * for exactly why: no browser-automation runtime exists anywhere in this
 * repository's dependency tree, "Hermes" throughout this codebase names
 * LLM-routing/orchestration functions only and has no browser-control
 * capability of its own, and neither Playwright nor a production TinyFish
 * dependency may be introduced).
 */
export class HermesLeadDiscoveryAgent {
  private readonly searchTools: DiscoverySearchTool[];

  constructor(searchTool: DiscoverySearchTool, additionalSearchTools: DiscoverySearchTool[] = []) {
    this.searchTools = [searchTool, ...additionalSearchTools];
  }

  /**
   * Runs one full discovery round for the given campaign + ICP: plan ->
   * search -> extract -> review -> validate. This is the method that
   * genuinely owns the workflow — every early return below is this agent
   * deciding what the rest of the pipeline should do next, not a provider
   * quietly doing AI work inside what should have been a search call.
   */
  async discover(criteria: DiscoveryCriteria, trackingClient?: TrackingClient): Promise<DiscoveryResult> {
    const telemetry = newTelemetry();

    const planned = await this.planDiscoveryQueries(criteria, trackingClient);
    if (!planned.ok) {
      return { ok: false, code: "provider_error", message: planned.message };
    }

    const searched = await this.runSearchProviders(planned.queries, telemetry);
    if (searched.succeeded.length === 0) {
      return {
        ok: false,
        code: "provider_error",
        message: `All ${planned.queries.length} discovery searches failed.${searched.firstError ? ` First error: ${searched.firstError}` : ""}`,
        telemetry,
      };
    }

    const totalHits = searched.succeeded.reduce((sum, o) => sum + o.results.length, 0);
    if (totalHits === 0) {
      return {
        ok: true,
        prospects: [],
        queriesRun: searched.succeeded.map((o) => o.query),
        queriesFailed: searched.queriesFailed,
        telemetry,
      };
    }

    const extracted = await this.extractCandidates(criteria, searched.succeeded, telemetry, trackingClient);
    if (!extracted.ok) {
      return { ok: false, code: "provider_error", message: extracted.message, telemetry };
    }

    const reviewed = await this.reviewCandidates(criteria, extracted.candidates, extracted.realHitByCanonicalUrl, telemetry, trackingClient);

    return this.validateCandidates(
      criteria,
      reviewed.candidates,
      extracted.realHitByCanonicalUrl,
      searched.succeeded.map((o) => o.query),
      searched.queriesFailed,
      telemetry
    );
  }

  /** Step 1: campaign + ICP -> real search queries, via Nemotron (see generateDiscoveryQueries's explicit model pinning in discovery.ts). */
  private planDiscoveryQueries(criteria: DiscoveryCriteria, trackingClient?: TrackingClient) {
    return generateDiscoveryQueries(criteria, trackingClient);
  }

  /**
   * Step 2: run every planned query against EVERY configured search tool —
   * the primary tool (Tavily, with Exa as its own same-query fallback,
   * entirely untouched by this agent) always, plus any additionalSearchTools
   * (none, in this deployment today) additively. A query counts as succeeded the
   * moment ANY tool returns a real (ok:true) result for it, and its merged
   * results are the union of every tool that succeeded — so one source's
   * failure for a query never discards another source's real results for
   * that same query. With a single tool (the default, and every existing
   * caller before this existed) this reduces to exactly the prior
   * one-tool-per-query behavior.
   */
  private async runSearchProviders(
    queries: string[],
    telemetry: ProviderTelemetry
  ): Promise<{
    succeeded: { query: string; results: SearchHit[] }[];
    queriesFailed: string[];
    firstError: string | null;
  }> {
    const perQuery = await Promise.all(
      queries.map(async (query) => {
        const toolOutcomes = await Promise.all(this.searchTools.map((tool) => tool.search(query, telemetry)));
        const succeededTools = toolOutcomes.filter(
          (result): result is { ok: true; results: SearchHit[] } => result.ok
        );
        const firstFailure = toolOutcomes.find((result): result is { ok: false; message: string } => !result.ok);
        return {
          query,
          ok: succeededTools.length > 0,
          results: succeededTools.flatMap((result) => result.results),
          error: firstFailure?.message ?? null,
        };
      })
    );

    const succeeded = perQuery.filter((p) => p.ok).map((p) => ({ query: p.query, results: p.results }));
    const queriesFailed = perQuery.filter((p) => !p.ok).map((p) => p.query);
    const firstError = perQuery.find((p) => !p.ok)?.error ?? null;

    return { succeeded, queriesFailed, firstError };
  }

  /** Step 3: real search results -> candidate prospects, via Nemotron again (same explicit pinning as planning). */
  private extractCandidates(
    criteria: DiscoveryCriteria,
    searchesByQuery: { query: string; results: SearchHit[] }[],
    telemetry: ProviderTelemetry,
    trackingClient?: TrackingClient
  ) {
    return extractProspectsFromResults(criteria, searchesByQuery, telemetry, trackingClient);
  }

  /** Step 4: candidates -> the Independent Hermes Reviewer (a genuinely different, forced model — see discovery.ts). Degrades gracefully on its own; never throws away candidates. */
  private reviewCandidates(
    criteria: DiscoveryCriteria,
    candidates: DiscoveredProspect[],
    realHitByCanonicalUrl: Map<string, SearchHit>,
    telemetry: ProviderTelemetry,
    trackingClient?: TrackingClient
  ) {
    return runFinalHermesValidation(criteria, candidates, realHitByCanonicalUrl, telemetry, trackingClient);
  }

  /** Step 5: the Deterministic Validator — pure code, no AI, no network. Runs on whatever the Reviewer accepted, or on the unreviewed candidates if it failed. */
  private validateCandidates(
    criteria: DiscoveryCriteria,
    candidates: DiscoveredProspect[],
    realHitByCanonicalUrl: Map<string, SearchHit>,
    queriesRun: string[],
    queriesFailed: string[],
    telemetry: ProviderTelemetry
  ): DiscoveryResult {
    return finalizeDiscoveryResult(criteria, candidates, realHitByCanonicalUrl, queriesRun, queriesFailed, telemetry);
  }
}
