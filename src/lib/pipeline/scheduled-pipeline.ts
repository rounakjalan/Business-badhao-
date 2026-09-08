import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { completeAgentRun, createAgentRun } from "@/lib/ai/tracking/agent-runs";
import { getBusinessContext, selectDiscoveryContext } from "@/lib/business-context";
import { isDiscoveryDue, markDiscoveryFinished, markDiscoveryRunning } from "@/lib/pipeline/discovery-schedule";
import { runBatchedDiscovery } from "@/lib/pipeline/discovery-batch";
import { qualifyLead, researchLead, sendAutomaticWhatsAppOutreach } from "@/lib/pipeline/lead-pipeline";
import type { Database, Json } from "@/types/database.types";

type Client = SupabaseClient<Database>;

export type PipelineRunSummary = {
  startedAt: string;
  campaignsConsidered: number;
  /** Draft/planning campaigns that already had a real ICP, flipped to active so the pipeline could reach them without a manual Launch click. */
  autoLaunched: string[];
  leadsFinished: number;
  leadsFailed: number;
  discoveryRuns: number;
  newLeads: number;
  skipped: { campaignId: string; reason: string }[];
  outreach: OutreachSweepSummary;
};

/**
 * Tallies what selectOutreachChannel/sendAutomaticWhatsAppOutreach actually
 * did across every qualified lead this run touched — never a claim that a
 * message was delivered, only what this deployment attempted and what Meta
 * (or the eligibility check) actually reported back. gmailManualPending
 * counts leads left for a human to send Gmail outreach to manually (this
 * automatic sweep never sends email itself); noChannelAvailable counts
 * leads with no usable channel at all right now (e.g. no phone, no
 * connected account) — never silently dropped, always one of these buckets.
 */
export type OutreachSweepSummary = {
  whatsappSent: number;
  whatsappFailed: number;
  gmailManualPending: number;
  noChannelAvailable: number;
};

export function emptyOutreachSummary(): OutreachSweepSummary {
  return { whatsappSent: 0, whatsappFailed: 0, gmailManualPending: 0, noChannelAvailable: 0 };
}

export function addOutreachSummary(into: OutreachSweepSummary, from: OutreachSweepSummary) {
  into.whatsappSent += from.whatsappSent;
  into.whatsappFailed += from.whatsappFailed;
  into.gmailManualPending += from.gmailManualPending;
  into.noChannelAvailable += from.noChannelAvailable;
}

/**
 * Don't re-discover a campaign that was searched minutes ago — a manual run
 * has already spent the search budget and would mostly return the same
 * businesses to be deduplicated away again.
 *
 * Deliberately shorter than the hourly cycle this now drives: the campaign's
 * own discovery_next_run_at is what decides when a run is due (see
 * isDiscoveryDue), and a cooldown at or above the interval would veto every
 * scheduled run before that slot was ever consulted. This is the backstop for
 * a manual run and a scheduled one landing on top of each other, nothing more.
 */
const DISCOVERY_COOLDOWN_MS = 55 * 60 * 1000;

/** Ceiling on how many stale leads one scheduled run will finish per campaign. */
const MAX_LEADS_FINISHED_PER_CAMPAIGN = 12;

export type EligibleCampaign = {
  id: string;
  organizationId: string;
  wasAutoLaunched: boolean;
  /**
   * Whether this campaign's *discovery* is due this sweep. Backlog work
   * (finishPendingLeads) is deliberately not gated on it: a campaign whose
   * discovery the user stopped should still have its already-discovered leads
   * researched and qualified, or stopping discovery would quietly strand
   * every lead it had already found.
   */
  discoveryDue: boolean;
  /** Set when discovery is not due, so the run summary can say why rather than reporting a silent skip. */
  discoverySkipReason: "stopped" | "not_due" | null;
};

/**
 * Finds every campaign the scheduled pipeline should touch this run, and
 * launches the ones that are only sitting in "draft"/"planning" because
 * nobody has clicked Launch yet.
 *
 * createCampaign saves the ICP the moment it is generated, regardless of
 * whether the user chose "Save draft" or "Launch" — so a draft can already
 * hold a complete, human-reviewed ICP with nothing left to decide. Leaving
 * it there meant the pipeline could never reach it without a manual click,
 * which is exactly the gap between the campaign and lead spaces this closes.
 * A campaign is never auto-launched without a usable ICP: that would just
 * flip its status and immediately do nothing, since ICP-less campaigns are
 * still correctly skipped downstream.
 *
 * "active" campaigns are included unchanged — auto-launch only ever moves a
 * campaign toward active, never away from it, so pausing one still switches
 * its automation off exactly as it does everywhere else in the app.
 */
export async function findEligibleCampaigns(supabase: Client): Promise<EligibleCampaign[]> {
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, organization_id, status, ideal_customer_profile_id, discovery_state, discovery_next_run_at, discovery_last_run_at")
    .in("status", ["active", "draft", "planning"])
    .not("ideal_customer_profile_id", "is", null);

  if (!campaigns || campaigns.length === 0) return [];

  const icpIds = [...new Set(campaigns.map((c) => c.ideal_customer_profile_id).filter((id): id is string => Boolean(id)))];
  const { data: icps } = await supabase.from("ideal_customer_profiles").select("id, criteria").in("id", icpIds);
  const criteriaById = new Map((icps ?? []).map((i) => [i.id, i.criteria as Record<string, unknown> | null]));

  const eligible: EligibleCampaign[] = [];
  for (const campaign of campaigns) {
    const criteria = campaign.ideal_customer_profile_id ? criteriaById.get(campaign.ideal_customer_profile_id) : null;
    if (!criteria || Object.keys(criteria).length === 0) continue;

    const discoveryDue = isDiscoveryDue(campaign);
    const discoverySkipReason = discoveryDue ? null : campaign.discovery_state === "stopped" ? "stopped" : "not_due";

    if (campaign.status !== "active") {
      const { error } = await supabase.from("campaigns").update({ status: "active" }).eq("id", campaign.id);
      if (error) continue; // Leave it for next run rather than processing a campaign still shown as draft.
      eligible.push({ id: campaign.id, organizationId: campaign.organization_id, wasAutoLaunched: true, discoveryDue, discoverySkipReason });
    } else {
      eligible.push({ id: campaign.id, organizationId: campaign.organization_id, wasAutoLaunched: false, discoveryDue, discoverySkipReason });
    }
  }

  return eligible;
}

function outOfTime(startedAtMs: number, budgetMs: number, reserveMs = 55_000) {
  return Date.now() - startedAtMs > budgetMs - reserveMs;
}

/**
 * Researches and qualifies leads that never got that far — deferred when a
 * discovery run hit its time budget, including leads a campaign's own
 * discovery step (runDiscoveryForCampaign) just created moments ago in the
 * same sweep. This is the part that stops the user having to open each lead
 * and press two buttons.
 *
 * research_status (see the migration adding it) is what makes this safe to
 * run unattended, every hour, forever:
 * - 'completed' — this lead already has real research on file. Never
 *   re-researched (that would both waste the AI/search budget and create a
 *   second lead_research row for no reason); if qualification alone didn't
 *   finish last time, it is retried using the research already on file.
 * - 'failed' — genuinely attempted and it didn't work. Excluded from the
 *   query entirely: the automatic pipeline never retries a failed lead on a
 *   later cycle, which would otherwise cost a real model call every single
 *   hour forever for a lead that may never succeed. It is left exactly as
 *   researchLead left it, for a human to retry with the existing manual
 *   "Run AI Research" button — that button calls the same researchLead
 *   regardless of the lead's current status, so the retry is unaffected.
 * - 'pending' / 'researching' — never attempted, or a previous attempt died
 *   mid-run without reaching a terminal status (a serverless timeout, say).
 *   Either way, safe and correct to attempt now.
 *
 * Qualification still only runs on a lead with real research on file,
 * exactly as in the interactive path: a lead is never scored on discovery
 * evidence alone, whoever triggered it. A failure on one lead — research or
 * qualification — never stops the rest of the batch; it is recorded and the
 * loop moves on.
 *
 * A lead that qualifies goes straight on to sendAutomaticWhatsAppOutreach —
 * this is what makes WhatsApp outreach automatic rather than requiring
 * someone to open the lead and click Send. A failure there (no channel
 * available, WhatsApp rejected the send, generation failed) never counts
 * against `failed` here — qualification itself succeeded; outreach's own
 * outcome is tallied separately in the returned outreach summary.
 */
export async function finishPendingLeads(
  supabase: Client,
  organizationId: string,
  campaignId: string,
  startedAtMs: number,
  budgetMs: number,
  /**
   * How many pending leads one call may pick up. Defaults to the hourly
   * cron's own conservative ceiling; a caller with a bigger, one-off budget
   * right now (the manual "Start Discovery" press, see
   * startLeadDiscoveryAction) can raise this — the real backstop against
   * running long either way is the outOfTime check in the loop below, not
   * this count.
   */
  maxLeads: number = MAX_LEADS_FINISHED_PER_CAMPAIGN
): Promise<{ finished: number; failed: number; outreach: OutreachSweepSummary }> {
  const { data: pending } = await supabase
    .from("leads")
    .select("id, research_status")
    .eq("organization_id", organizationId)
    .eq("campaign_id", campaignId)
    .eq("qualification_status", "pending")
    .neq("research_status", "failed")
    .order("created_at", { ascending: true })
    .limit(maxLeads);

  let finished = 0;
  let failed = 0;
  const outreach = emptyOutreachSummary();

  for (const lead of pending ?? []) {
    if (outOfTime(startedAtMs, budgetMs)) break;

    if (lead.research_status !== "completed") {
      const research = await researchLead(supabase, organizationId, lead.id);
      if (!research.ok) {
        failed += 1;
        continue;
      }
    }

    const qualification = await qualifyLead(supabase, organizationId, lead.id);
    if (!qualification.ok) {
      failed += 1;
      continue;
    }
    finished += 1;

    if (qualification.qualification.recommendedStatus !== "qualified") continue;

    const outcome = await sendAutomaticWhatsAppOutreach(supabase, organizationId, lead.id);
    if (outcome.attempted) {
      if (outcome.ok) outreach.whatsappSent += 1;
      else outreach.whatsappFailed += 1;
    } else if (outcome.channel === "gmail_manual") {
      outreach.gmailManualPending += 1;
    } else if (outcome.reason !== "already_contacted" && outcome.reason !== "already_sent" && outcome.reason !== "not_found") {
      // Every other skip reason (no phone, WhatsApp not connected/no
      // template, campaign opted out, max attempts reached, generation
      // failed) means this lead genuinely has no automatic channel right
      // now — worth surfacing. A lead already contacted/already sent isn't
      // a gap to report; it's this function correctly doing nothing again.
      outreach.noChannelAvailable += 1;
    }
  }

  return { finished, failed, outreach };
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
  await markDiscoveryRunning(supabase, campaignId, organizationId);

  // Without the explicit client this returns empty Business Knowledge under
  // row-level security, silently ungrounding the whole run.
  const businessContext = await getBusinessContext(organizationId, supabase);

  // Same reason as getBusinessContext above: this scheduled run has no
  // signed-in user, so every AI call discover() makes needs this same
  // explicit client passed all the way down, or its own agent_runs/
  // model_usage telemetry rows are silently rejected by RLS while the AI
  // call itself still succeeds — the top-level row above already gets this
  // client; without threading it further, everything under it (query
  // generation, extraction, the Independent Reviewer) previously did not.
  //
  // Batched (see discovery-batch.ts): keeps calling discover() — each time
  // asking Nemotron/Groq to avoid the queries already tried — until it hits
  // a real target, runs out of its own time slice, or two batches in a row
  // turn up nothing genuinely new. A single batch's own provider error
  // never throws away an earlier batch's already-persisted leads.
  const result = await runBatchedDiscovery({
    supabase,
    organizationId,
    campaignId,
    campaignName: campaign.name,
    campaignObjective: campaign.objective,
    icpCriteria,
    businessContext: selectDiscoveryContext(businessContext),
    startedAtMs,
    budgetMs,
    agentRun,
    trackingClient: supabase,
  });

  if (!result.ok) {
    await completeAgentRun(
      agentRun,
      "failed",
      { code: result.code, message: result.message, scheduled: true } as unknown as Json,
      supabase
    );
    // A failed run still books its next attempt — one slot, the same single
    // slot a successful run writes, so a failure can never leave two
    // schedules behind or end the cycle on a transient provider error.
    await markDiscoveryFinished(supabase, campaignId, organizationId, { ok: false, error: result.message });
    return { ran: true, newLeads: 0, reason: result.code };
  }

  await completeAgentRun(
    agentRun,
    result.queriesFailed.length > 0 ? "partially_completed" : "completed",
    {
      scheduled: true,
      batchesRun: result.batchesRun,
      stoppedReason: result.stoppedReason,
      prospectsFound: result.prospectsFound,
      newLeadsCreated: result.newLeadsCreated,
      duplicatesSkipped: result.duplicatesSkipped,
      queriesRun: result.queriesRun,
      queriesFailed: result.queriesFailed,
      telemetry: result.batchTelemetry,
    } as unknown as Json,
    supabase
  );

  // Book the next run in this campaign's single schedule slot. This is what
  // makes discovery recurring: the run stops at its existing budget, and the
  // campaign comes back about an hour later looking for prospects it has not
  // already found (runBatchedDiscovery's own dedup is rebuilt from the
  // database each run, so everything discovered so far is excluded).
  await markDiscoveryFinished(supabase, campaignId, organizationId, { ok: true });

  return { ran: true, newLeads: result.newLeadsCreated };
}
