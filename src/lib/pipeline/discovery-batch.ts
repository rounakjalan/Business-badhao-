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
    }
  | { ok: false; code: "not_configured" | "provider_error"; message: string };

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
): Promise<{ leadId: string; summary: DiscoveredProspectSummary } | null> {
  let contactOutcome: ContactDiscoveryOutcome;
  try {
    contactOutcome = await discoverProspectContacts({
      companyName: prospect.companyName,
      website: prospect.website,
      location: prospect.location,
    });
  } catch (error) {
    console.error("[discovery-batch] contact discovery threw unexpectedly — proceeding without it", error);
    contactOutcome = { contacts: null, status: "not_found" };
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
 * This function owns discovery + persistence only. It does not research or
 * qualify anything — that is finishPendingLeads' job, called separately by
 * the caller with whatever budget remains (see campaigns/actions.ts and
 * scheduled-pipeline.ts), exactly as it already was before batching existed.
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
  } = params;

  const provider: DiscoveryProvider = getDiscoveryProvider();
  if (!provider.isConfigured()) {
    return { ok: false, code: "not_configured", message: "Lead discovery isn't connected to a data source yet." };
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
    return { ok: false, ...firstBatchFailure };
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
  };
}
