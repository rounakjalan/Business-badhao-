import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getDiscoveryProvider,
  prospectDedupeKey,
  type DiscoveredProspect,
  type DiscoveryProvider,
  type ProviderTelemetry,
} from "@/lib/ai/agents/discovery";
import { type AgentRunHandle, recordAgentAction } from "@/lib/ai/tracking/agent-runs";
import type { BusinessContext } from "@/lib/business-context";
import { discoverProspectContacts, mergeContactIntoRawData, type ContactDiscoveryOutcome } from "@/lib/discovery/contact-enrichment";
import type { Database, Json } from "@/types/database.types";

type Client = SupabaseClient<Database>;

export type DiscoveredProspectSummary = {
  companyName: string;
  website: string | null;
  location: string | null;
  industry: string | null;
  sourceUrl: string;
  evidenceSnippet: string;
  matchedIcpCriteria: string[];
};

/**
 * Tally of the Instagram Business Discovery verification step (see
 * instagram-verification.ts) across every prospect this run persisted.
 * Never a count of leads *found on* Instagram — this app has no compliant
 * way to search Instagram — only of already-discovered handles this run
 * checked against the org's own connected account.
 */
export type InstagramEnrichmentSummary = {
  verified: number;
  failed: number;
  /** Had a discovered handle but the org has no Instagram account connected — not a failure, just nothing to verify against yet. */
  notConnected: number;
};

function emptyInstagramSummary(): InstagramEnrichmentSummary {
  return { verified: 0, failed: 0, notConnected: 0 };
}

function tallyInstagramOutcome(summary: InstagramEnrichmentSummary, outcome: ContactDiscoveryOutcome["instagram"]): void {
  if (!outcome.attempted) {
    if (outcome.reason === "not_connected") summary.notConnected += 1;
    return;
  }
  if (outcome.ok) summary.verified += 1;
  else summary.failed += 1;
}

export type BatchDiscoveryStopReason =
  | "target_reached"
  | "no_more_results"
  | "max_batches"
  | "out_of_time"
  | "provider_error"
  | "not_configured";

export type BatchDiscoveryResult =
  | {
      ok: true;
      batchesRun: number;
      prospectsFound: number;
      newLeadsCreated: number;
      duplicatesSkipped: number;
      newLeadIds: string[];
      createdProspects: DiscoveredProspectSummary[];
      queriesRun: string[];
      queriesFailed: string[];
      stoppedReason: BatchDiscoveryStopReason;
      batchTelemetry: ProviderTelemetry[];
      instagram: InstagramEnrichmentSummary;
    }
  | {
      ok: false;
      code: "not_configured" | "provider_error";
      message: string;
      /**
       * How many discover() batches were actually attempted before this run
       * gave up — never discarded, even on a total failure: a caller
       * reporting "0 batches" for a run that genuinely tried 2 would hide
       * real information (see campaigns/actions.ts and scheduled-pipeline.ts,
       * which now record this on agent_runs.output either way).
       */
      batchesRun: number;
      queriesFailed: string[];
    };

/**
 * How many genuinely new prospects one call to this function tries to
 * accumulate before stopping on its own — the actual replacement for the
 * old, much smaller "however many fit in one follow-up budget" ceiling.
 * Configurable per call (see runBatchedDiscovery's own params) rather than
 * hard-coded at the call sites, so a future change to this number doesn't
 * require touching campaigns/actions.ts or scheduled-pipeline.ts.
 */
export const DEFAULT_TARGET_NEW_LEADS = 25;
/** Hard ceiling on rounds regardless of target — bounds worst-case AI/search spend per discovery press even if the ICP is unusually rich. */
export const DEFAULT_MAX_BATCHES = 6;
/** Two batches in a row finding nothing genuinely new means this ICP's easily-reachable pool is exhausted for now — further batches would just keep re-asking a search space that's already been covered. */
const CONSECUTIVE_EMPTY_BATCHES_BEFORE_STOP = 2;

function outOfTime(startedAtMs: number, budgetMs: number, reserveMs: number): boolean {
  return Date.now() - startedAtMs > budgetMs - reserveMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BATCH_RETRY_BASE_MS = 1000;
/** Ceiling on the pause between two failed batches — long enough to matter against a provider's own short rate-limit window, short enough that even a full CONSECUTIVE_EMPTY_BATCHES_BEFORE_STOP run of failures stays a small fraction of the overall budget. */
const BATCH_RETRY_MAX_MS = 5000;

/**
 * Bounded backoff with jitter between one failed discover() batch and the
 * next attempt. Distinct from retry.ts's own per-AI-call backoff (which
 * governs retries *within* a single Hermes call) and from
 * rate-limit-guard.ts's per-provider cooldown (which governs waits *before*
 * a call, shared across concurrent callers) — this one governs the gap
 * between two whole discover() batches in this same sequential loop, so a
 * batch that just failed (very often exactly because a provider is
 * rate-limited — see the discovery-batch.test.ts case this backs) doesn't
 * immediately re-fire into the same still-closed window a beat later.
 */
function batchRetryBackoffMs(attempt: number): number {
  const capped = Math.min(BATCH_RETRY_BASE_MS * 2 ** attempt, BATCH_RETRY_MAX_MS);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

/**
 * Persists one already-deduped DiscoveredProspect as a real prospects/leads
 * row, running the same contact-enrichment step every discovery path already
 * used. Returns the new lead's id and display summary, or null if either
 * insert failed (a genuine DB error, not a validation failure — the caller
 * simply moves on to the next prospect rather than losing the whole batch).
 */
async function persistDiscoveredProspect(
  supabase: Client,
  organizationId: string,
  campaignId: string,
  leadSourceId: string | null,
  discoverySourceName: string,
  prospect: DiscoveredProspect,
  agentRun: AgentRunHandle | null
): Promise<{ leadId: string; summary: DiscoveredProspectSummary; instagram: ContactDiscoveryOutcome["instagram"] } | null> {
  let contactOutcome: ContactDiscoveryOutcome;
  try {
    contactOutcome = await discoverProspectContacts({
      companyName: prospect.companyName,
      website: prospect.website,
      location: prospect.location,
      organizationId,
    });
  } catch (error) {
    console.error("[discovery-batch] contact discovery threw unexpectedly — proceeding without it", error);
    contactOutcome = { contacts: null, status: "not_found", instagram: { attempted: false, reason: "no_handle" } };
  }

  const { data: prospectRow } = await supabase
    .from("prospects")
    .insert({
      organization_id: organizationId,
      campaign_id: campaignId,
      lead_source_id: leadSourceId,
      company_name: prospect.companyName,
      email: prospect.email ?? contactOutcome.contacts?.email?.value ?? null,
      phone: prospect.phone ?? contactOutcome.contacts?.phone?.value ?? null,
      website: prospect.website,
      raw_data: mergeContactIntoRawData(
        {
          location: prospect.location,
          industry: prospect.industry,
          businessType: prospect.businessType,
          matchedIcpCriteria: prospect.matchedIcpCriteria,
          evidenceSnippet: prospect.evidenceSnippet,
          sourceUrl: prospect.sourceUrl,
          searchQuery: prospect.searchQuery,
          discoverySource: discoverySourceName,
          discoveredAt: new Date().toISOString(),
        },
        contactOutcome
      ) as unknown as Json,
    })
    .select("id")
    .single();

  if (!prospectRow) return null;

  const { data: leadRow } = await supabase
    .from("leads")
    .insert({
      organization_id: organizationId,
      prospect_id: prospectRow.id,
      campaign_id: campaignId,
      lead_source_id: leadSourceId,
      status: "new",
      qualification_status: "pending",
    })
    .select("id")
    .single();

  if (!leadRow) return null;

  if (agentRun) {
    await recordAgentAction({
      organizationId,
      agentRunId: agentRun.id,
      actionType: "lead_discovered",
      targetEntityType: "lead",
      targetEntityId: leadRow.id,
      payload: { companyName: prospect.companyName, sourceUrl: prospect.sourceUrl } as unknown as Json,
      client: supabase,
    });
  }

  return {
    leadId: leadRow.id,
    summary: {
      companyName: prospect.companyName,
      website: prospect.website,
      location: prospect.location,
      industry: prospect.industry,
      sourceUrl: prospect.sourceUrl,
      evidenceSnippet: prospect.evidenceSnippet,
      matchedIcpCriteria: prospect.matchedIcpCriteria,
    },
    instagram: contactOutcome.instagram,
  };
}

export type BatchDiscoveryParams = {
  supabase: Client;
  organizationId: string;
  campaignId: string;
  campaignName: string;
  campaignObjective: string | null;
  icpCriteria: Record<string, unknown>;
  businessContext: BusinessContext | null;
  /** Own request-lifecycle timestamp — shared with whatever the caller does after this (e.g. finishPendingLeads). */
  startedAtMs: number;
  /** How much of the total request budget this batching phase itself may spend. */
  budgetMs: number;
  /** Stop once this many genuinely new (cross-run- and within-run-deduped) leads have been created. */
  targetNewLeads?: number;
  /** Hard ceiling on discover() calls this invocation will make, regardless of target. */
  maxBatches?: number;
  /**
   * The caller's own top-level agent_runs row (e.g. "lead_discovery") —
   * passed through to recordAgentAction per persisted lead, exactly as
   * before batching existed. Also the client every discover() call's own
   * AI-stage telemetry is written through — see HermesRequest.client's own
   * doc comment for why a scheduled/no-session caller must pass one.
   */
  agentRun: AgentRunHandle | null;
  trackingClient?: Client;
  /**
   * Called synchronously right after a prospect is successfully persisted
   * as a real lead — before the next prospect in this same batch is even
   * persisted, let alone the next batch's discover() call. This is what
   * lets research start the moment a lead exists rather than waiting for
   * the whole run to finish: the caller passes a bounded worker pool's own
   * enqueue (see lead-worker-pool.ts), which returns immediately without
   * awaiting the research itself, so this loop is never slowed down by it.
   */
  onLeadPersisted?: (leadId: string) => void;
};

/**
 * Lead Discovery, batched: calls the existing, unmodified discover() pipeline
 * (Hermes -> Nemotron -> Tavily/Exa -> Nemotron -> Independent Hermes ->
 * Deterministic Validator — completely untouched by this function) as many
 * times as it takes to reach a real target, persisting each batch's valid
 * leads immediately rather than only at the very end. A single batch's own
 * failure (a transient provider error) is recorded and skipped, not treated
 * as the whole run failing — whatever earlier batches already found stays
 * saved. Each batch asks the Reasoner to avoid the queries already tried
 * (DiscoveryCriteria.excludeQueries) so a second/third batch searches
 * genuinely different ground instead of re-running the same 3-5 queries.
 *
 * This function owns discovery + persistence only — it never calls
 * researchLead/qualifyLead itself. Research is triggered via the optional
 * onLeadPersisted callback (see BatchDiscoveryParams), which the caller
 * wires to a bounded worker pool's enqueue (lead-worker-pool.ts) so that a
 * lead starts real research the moment it exists, running concurrently
 * with whatever batch this function calls next, rather than waiting for
 * this entire function to return first.
 */
export async function runBatchedDiscovery(params: BatchDiscoveryParams): Promise<BatchDiscoveryResult> {
  const {
    supabase,
    organizationId,
    campaignId,
    campaignName,
    campaignObjective,
    icpCriteria,
    businessContext,
    startedAtMs,
    budgetMs,
    targetNewLeads = DEFAULT_TARGET_NEW_LEADS,
    maxBatches = DEFAULT_MAX_BATCHES,
    agentRun,
    trackingClient,
    onLeadPersisted,
  } = params;

  const provider: DiscoveryProvider = getDiscoveryProvider();
  if (!provider.isConfigured()) {
    return { ok: false, code: "not_configured", message: "Lead discovery isn't connected to a data source yet.", batchesRun: 0, queriesFailed: [] };
  }

  const { data: existingProspects } = await supabase.from("prospects").select("website, company_name").eq("organization_id", organizationId);
  const seenKeys = new Set((existingProspects ?? []).map((p) => prospectDedupeKey({ website: p.website, companyName: p.company_name ?? "" })));

  let leadSourceId: string | null = null;
  async function ensureLeadSourceId(): Promise<string | null> {
    if (leadSourceId) return leadSourceId;
    const { data: existingSource } = await supabase
      .from("lead_sources")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("type", "ai_discovery")
      .maybeSingle();
    leadSourceId = existingSource?.id ?? null;
    if (!leadSourceId) {
      const { data: createdSource } = await supabase
        .from("lead_sources")
        .insert({ organization_id: organizationId, name: "AI Lead Discovery", type: "ai_discovery" })
        .select("id")
        .single();
      leadSourceId = createdSource?.id ?? null;
    }
    return leadSourceId;
  }

  const allQueriesTried: string[] = [];
  const queriesRun: string[] = [];
  const queriesFailed: string[] = [];
  const createdProspects: DiscoveredProspectSummary[] = [];
  const newLeadIds: string[] = [];
  const batchTelemetry: ProviderTelemetry[] = [];
  let prospectsFound = 0;
  let newLeadsCreated = 0;
  let duplicatesSkipped = 0;
  let consecutiveEmptyBatches = 0;
  const instagramSummary = emptyInstagramSummary();
  let batchesRun = 0;
  let stoppedReason: BatchDiscoveryStopReason = "max_batches";
  let firstBatchFailure: { code: "not_configured" | "provider_error"; message: string } | null = null;

  while (batchesRun < maxBatches) {
    if (outOfTime(startedAtMs, budgetMs, 20_000)) {
      stoppedReason = "out_of_time";
      break;
    }

    const result = await provider.discover(
      {
        organizationId,
        campaignName,
        campaignObjective,
        icpCriteria,
        businessContext,
        excludeQueries: allQueriesTried.length > 0 ? [...allQueriesTried] : undefined,
      },
      trackingClient
    );
    batchesRun += 1;

    if (!result.ok) {
      if (batchesRun === 1) firstBatchFailure = { code: result.code, message: result.message };
      if (result.code === "not_configured") {
        stoppedReason = "not_configured";
        break;
      }
      // A transient provider error on this one batch — record it and move
      // on; earlier batches' leads are already safely persisted. Two of
      // these in a row is treated the same as two genuinely empty batches:
      // whatever is wrong right now isn't clearing up within this run.
      queriesFailed.push(`[batch ${batchesRun} failed: ${result.message}]`);
      consecutiveEmptyBatches += 1;
      if (consecutiveEmptyBatches >= CONSECUTIVE_EMPTY_BATCHES_BEFORE_STOP) {
        stoppedReason = "provider_error";
        break;
      }
      // Give a transient provider failure (very often a rate limit shared
      // with concurrently-running research jobs) a moment to clear before
      // this loop's next attempt, instead of immediately re-hammering the
      // same still-closed window.
      await sleep(batchRetryBackoffMs(consecutiveEmptyBatches - 1));
      continue;
    }

    if (result.telemetry) batchTelemetry.push(result.telemetry);
    queriesRun.push(...result.queriesRun);
    queriesFailed.push(...result.queriesFailed);
    allQueriesTried.push(...result.queriesRun, ...result.queriesFailed);
    prospectsFound += result.prospects.length;

    const newInThisBatch = result.prospects.filter((p) => !seenKeys.has(prospectDedupeKey(p)));
    duplicatesSkipped += result.prospects.length - newInThisBatch.length;

    let newLeadsThisBatch = 0;
    if (newInThisBatch.length > 0) {
      const sourceId = await ensureLeadSourceId();
      for (const prospect of newInThisBatch) {
        seenKeys.add(prospectDedupeKey(prospect));
        const persisted = await persistDiscoveredProspect(supabase, organizationId, campaignId, sourceId, provider.name, prospect, agentRun);
        if (!persisted) continue;
        newLeadIds.push(persisted.leadId);
        createdProspects.push(persisted.summary);
        newLeadsCreated += 1;
        newLeadsThisBatch += 1;
        tallyInstagramOutcome(instagramSummary, persisted.instagram);
        // Fired immediately, before the next prospect in this batch is even
        // persisted — see onLeadPersisted's own doc comment above. Wrapped
        // defensively: a bug in whatever this triggers (a worker pool's own
        // enqueue) must never abort discovery or lose a lead this function
        // already persisted — the one thing discovery genuinely owns.
        try {
          onLeadPersisted?.(persisted.leadId);
        } catch (error) {
          console.error("[discovery-batch] onLeadPersisted threw unexpectedly — continuing discovery regardless", error);
        }

        if (newLeadsCreated >= targetNewLeads) break;
      }
    }

    if (newLeadsCreated >= targetNewLeads) {
      stoppedReason = "target_reached";
      break;
    }

    consecutiveEmptyBatches = newLeadsThisBatch === 0 ? consecutiveEmptyBatches + 1 : 0;
    if (consecutiveEmptyBatches >= CONSECUTIVE_EMPTY_BATCHES_BEFORE_STOP) {
      stoppedReason = "no_more_results";
      break;
    }
  }

  // Only report a hard failure when NOTHING was ever accomplished — any
  // batch that actually persisted a lead means this run found real,
  // grounded prospects and must never be reported as a failure just
  // because a later batch had a rough time or the ICP ran dry.
  if (newLeadsCreated === 0 && prospectsFound === 0 && firstBatchFailure) {
    return { ok: false, ...firstBatchFailure, batchesRun, queriesFailed };
  }

  return {
    ok: true,
    batchesRun,
    prospectsFound,
    newLeadsCreated,
    duplicatesSkipped,
    newLeadIds,
    createdProspects,
    queriesRun,
    queriesFailed,
    stoppedReason,
    batchTelemetry,
    instagram: instagramSummary,
  };
}
