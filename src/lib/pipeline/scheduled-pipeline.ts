import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDiscoveryProvider, prospectDedupeKey } from "@/lib/ai/agents/discovery";
import { completeAgentRun, createAgentRun, recordAgentAction } from "@/lib/ai/tracking/agent-runs";
import { getBusinessContext, selectDiscoveryContext } from "@/lib/business-context";
import { qualifyLead, researchLead } from "@/lib/pipeline/lead-pipeline";
import type { Database, Json } from "@/types/database.types";

type Client = SupabaseClient<Database>;

export type PipelineRunSummary = {
  startedAt: string;
  campaignsConsidered: number;
  leadsFinished: number;
  leadsFailed: number;
  discoveryRuns: number;
  newLeads: number;
  skipped: { campaignId: string; reason: string }[];
};

/**
 * Don't re-discover a campaign that was searched recently. The schedule is
 * daily, but a manual run an hour earlier has already spent the search
 * budget and would mostly return the same businesses to be deduplicated
 * away again.
 */
const DISCOVERY_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/** Ceiling on how many stale leads one scheduled run will finish per campaign. */
const MAX_LEADS_FINISHED_PER_CAMPAIGN = 12;

function outOfTime(startedAtMs: number, budgetMs: number, reserveMs = 55_000) {
  return Date.now() - startedAtMs > budgetMs - reserveMs;
}

/**
 * Researches and qualifies leads that never got that far — deferred when a
 * discovery run hit its time budget, or left behind when research failed.
 * This is the part that stops the user having to open each lead and press
 * two buttons.
 *
 * Qualification still only runs on a lead whose research succeeded, exactly
 * as in the interactive path: a lead is never scored on discovery evidence
 * alone, whoever triggered it.
 */
export async function finishPendingLeads(
  supabase: Client,
  organizationId: string,
  campaignId: string,
  startedAtMs: number,
  budgetMs: number
): Promise<{ finished: number; failed: number }> {
  const { data: pending } = await supabase
    .from("leads")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("campaign_id", campaignId)
    .eq("qualification_status", "pending")
    .order("created_at", { ascending: true })
    .limit(MAX_LEADS_FINISHED_PER_CAMPAIGN);

  let finished = 0;
  let failed = 0;

  for (const lead of pending ?? []) {
    if (outOfTime(startedAtMs, budgetMs)) break;

    const research = await researchLead(supabase, organizationId, lead.id);
    if (!research.ok) {
      failed += 1;
      continue;
    }

    const qualification = await qualifyLead(supabase, organizationId, lead.id);
    if (qualification.ok) finished += 1;
    else failed += 1;
  }

  return { finished, failed };
}

/**
 * One scheduled discovery pass for a campaign. Mirrors the interactive
 * action, minus the session: same provider, same seller-identity exclusion,
 * same cross-run deduplication, same agent-run record — so a scheduled run
 * is indistinguishable from a manual one in the campaign's history.
 *
 * Newly created leads are deliberately left at "pending" rather than
 * researched inline. The next scheduled pass picks them up through
 * finishPendingLeads, which keeps any single invocation inside the
 * platform's function time limit however many leads a search turns up.
 */
export async function runDiscoveryForCampaign(
  supabase: Client,
  organizationId: string,
  campaignId: string,
  startedAtMs: number,
  budgetMs: number
): Promise<{ ran: boolean; newLeads: number; reason?: string }> {
  if (outOfTime(startedAtMs, budgetMs, 90_000)) return { ran: false, newLeads: 0, reason: "out_of_time" };

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, name, objective, ideal_customer_profile_id")
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!campaign?.ideal_customer_profile_id) return { ran: false, newLeads: 0, reason: "no_icp" };

  const { data: icp } = await supabase
    .from("ideal_customer_profiles")
    .select("criteria")
    .eq("id", campaign.ideal_customer_profile_id)
    .maybeSingle();

  const icpCriteria = (icp?.criteria as Record<string, unknown> | null) ?? null;
  if (!icpCriteria || Object.keys(icpCriteria).length === 0) return { ran: false, newLeads: 0, reason: "no_icp" };

  // Respect a run already in flight, and a recent one — whether it was
  // started here or by someone pressing the button.
  const { data: recentRuns } = await supabase
    .from("agent_runs")
    .select("status, started_at")
    .eq("organization_id", organizationId)
    .eq("agent_type", "lead_discovery")
    .contains("input", { campaignId })
    .order("started_at", { ascending: false })
    .limit(1);

  const recent = recentRuns?.[0];
  if (recent) {
    const startedAt = recent.started_at ? Date.parse(recent.started_at) : NaN;
    const age = Number.isNaN(startedAt) ? Infinity : Date.now() - startedAt;
    if (recent.status === "running" && age < 15 * 60 * 1000) return { ran: false, newLeads: 0, reason: "already_running" };
    if (age < DISCOVERY_COOLDOWN_MS) return { ran: false, newLeads: 0, reason: "ran_recently" };
  }

  const agentRun = await createAgentRun(organizationId, "lead_discovery", { campaignId, scheduled: true } as unknown as Json, supabase);
  // Without the explicit client this returns empty Business Knowledge under
  // row-level security, silently ungrounding the whole run.
  const businessContext = await getBusinessContext(organizationId, supabase);

  const provider = getDiscoveryProvider();
  const result = await provider.discover({
    organizationId,
    campaignName: campaign.name,
    campaignObjective: campaign.objective,
    icpCriteria,
    businessContext: selectDiscoveryContext(businessContext),
  });

  if (!result.ok) {
    await completeAgentRun(
      agentRun,
      "failed",
      { code: result.code, message: result.message, telemetry: result.telemetry ?? null, scheduled: true } as unknown as Json,
      supabase
    );
    return { ran: true, newLeads: 0, reason: result.code };
  }

  const { data: existingProspects } = await supabase
    .from("prospects")
    .select("website, company_name")
    .eq("organization_id", organizationId);

  const existingKeys = new Set(
    (existingProspects ?? []).map((p) => prospectDedupeKey({ website: p.website, companyName: p.company_name ?? "" }))
  );

  const newProspects = result.prospects.filter((p) => !existingKeys.has(prospectDedupeKey(p)));
  const duplicatesSkipped = result.prospects.length - newProspects.length;

  let leadSourceId: string | null = null;
  if (newProspects.length > 0) {
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
  }

  let newLeadsCreated = 0;
  for (const prospect of newProspects) {
    const { data: prospectRow } = await supabase
      .from("prospects")
      .insert({
        organization_id: organizationId,
        campaign_id: campaignId,
        lead_source_id: leadSourceId,
        company_name: prospect.companyName,
        email: prospect.email,
        phone: prospect.phone,
        website: prospect.website,
        raw_data: {
          location: prospect.location,
          industry: prospect.industry,
          businessType: prospect.businessType,
          matchedIcpCriteria: prospect.matchedIcpCriteria,
          evidenceSnippet: prospect.evidenceSnippet,
          sourceUrl: prospect.sourceUrl,
          searchQuery: prospect.searchQuery,
          discoverySource: provider.name,
          discoveredAt: new Date().toISOString(),
        } as unknown as Json,
      })
      .select("id")
      .single();

    if (!prospectRow) continue;

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

    if (!leadRow) continue;
    newLeadsCreated += 1;

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
  }

  await completeAgentRun(
    agentRun,
    result.queriesFailed.length > 0 ? "partially_completed" : "completed",
    {
      scheduled: true,
      prospectsFound: result.prospects.length,
      newLeadsCreated,
      duplicatesSkipped,
      queriesRun: result.queriesRun,
      queriesFailed: result.queriesFailed,
      telemetry: result.telemetry ?? null,
    } as unknown as Json,
    supabase
  );

  return { ran: true, newLeads: newLeadsCreated };
}
