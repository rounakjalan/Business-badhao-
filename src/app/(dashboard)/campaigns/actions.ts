"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runCampaignPlanner, type CampaignPlan, type CampaignPlannerResult } from "@/lib/ai/agents/campaign-planner";
import { IcpSchema, runIcpGenerator, type IcpGeneratorResult } from "@/lib/ai/agents/icp-generator";
import { completeAgentRun, createAgentRun } from "@/lib/ai/tracking/agent-runs";
import { getBusinessContext, selectDiscoveryContext } from "@/lib/business-context";
import {
  getCampaignDiscoverySchedule,
  markDiscoveryFinished,
  markDiscoveryRunning,
  minutesUntilNextRun,
  resumeCampaignDiscovery,
  stopCampaignDiscovery,
  type CampaignDiscoverySchedule,
} from "@/lib/pipeline/discovery-schedule";
import { runBatchedDiscovery, type BatchDiscoveryStopReason, type DiscoveredProspectSummary, type InstagramEnrichmentSummary } from "@/lib/pipeline/discovery-batch";
import { createLeadWorkerPool, type OutreachSweepSummary } from "@/lib/pipeline/lead-worker-pool";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Json, TablesUpdate } from "@/types/database.types";

/**
 * Generates a campaign plan, or revises the one the user already has.
 *
 * Passing currentPlan together with refinementRequest switches the planner
 * into revision mode, where it edits that plan instead of writing a new
 * one — see runCampaignPlanner. Both are optional so the wizard's
 * first-time "Generate" call is unchanged.
 *
 * The organization's Business Knowledge is always loaded and passed in;
 * it's what keeps the plan grounded in what this business actually sells.
 */
export async function generateCampaignPlan(input: {
  name: string;
  objective: string;
  description: string;
  customerType: string;
  location: string;
  currentPlan?: CampaignPlan | null;
  refinementRequest?: string | null;
}): Promise<CampaignPlannerResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    return { ok: false, message: "Sign in to a workspace to generate a campaign plan." };
  }

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  return runCampaignPlanner({
    organizationId: currentOrg.organizationId,
    organizationName: currentOrg.organizationName,
    campaignName: input.name,
    objective: input.objective,
    description: input.description,
    customerType: input.customerType,
    location: input.location,
    businessContext,
    currentPlan: input.currentPlan ?? null,
    refinementRequest: input.refinementRequest ?? null,
  });
}

export async function generateIcp(input: {
  name: string;
  objective: string;
  description: string;
  plan: CampaignPlan;
}): Promise<IcpGeneratorResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    return { ok: false, message: "Sign in to a workspace to generate an ideal customer profile." };
  }

  return runIcpGenerator({
    organizationId: currentOrg.organizationId,
    organizationName: currentOrg.organizationName,
    campaignName: input.name,
    objective: input.objective,
    description: input.description,
    plan: input.plan,
  });
}

export async function createCampaign(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const objective = String(formData.get("objective") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const targetAudience = String(formData.get("targetAudience") ?? "").trim();
  const launch = formData.get("launch") === "true";
  const icpRaw = String(formData.get("icp") ?? "");

  if (!name) {
    redirect(`/campaigns/create?error=${encodeURIComponent("Campaign name is required.")}`);
  }

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    redirect("/onboarding");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The AI plan and ICP (if the user generated and kept them) are optional
  // and re-validated here rather than trusted as-is — they arrived through
  // hidden form fields, so they're still just client-supplied data at this
  // point. Nothing is written to Supabase until this single insert, so
  // regenerating either in the wizard (client-side state) or refreshing
  // the page (loses in-progress wizard state, same as before this feature)
  // can never produce duplicate campaigns or duplicate ICP rows.
  let idealCustomerProfileId: string | null = null;
  if (icpRaw) {
    // Malformed hidden-field JSON should never abort campaign creation
    // entirely — treat it the same as no ICP having been generated.
    let parsedIcpJson: unknown = undefined;
    try {
      parsedIcpJson = JSON.parse(icpRaw);
    } catch {
      parsedIcpJson = undefined;
    }
    const icpParse = parsedIcpJson !== undefined ? IcpSchema.safeParse(parsedIcpJson) : null;
    if (icpParse?.success) {
      const icp = icpParse.data;
      const { data: savedIcp } = await supabase
        .from("ideal_customer_profiles")
        .insert({
          organization_id: currentOrg.organizationId,
          name: `${name} — ICP`,
          description: icp.targetCustomer,
          criteria: icp,
          created_by: user?.id ?? null,
        })
        .select("id")
        .single();
      idealCustomerProfileId = savedIcp?.id ?? null;
    }
  }

  const { data: campaign, error } = await supabase
    .from("campaigns")
    .insert({
      organization_id: currentOrg.organizationId,
      ideal_customer_profile_id: idealCustomerProfileId,
      name,
      objective: objective || null,
      description: description || null,
      target_audience: targetAudience || null,
      status: launch ? "active" : "draft",
      created_by: user?.id ?? null,
    })
    .select("id")
    .single();

  if (error || !campaign) {
    redirect(`/campaigns/create?error=${encodeURIComponent(error?.message ?? "Could not create campaign.")}`);
  }

  redirect(`/campaigns/${campaign.id}`);
}

/**
 * Changes a campaign's status.
 *
 * Scoped to the caller's organization and error-checked. Row-level security
 * already blocks a cross-organization write, so the scoping is defence in
 * depth rather than the only guard — but without checking the result, a
 * rejected update looked identical to a successful one and the button
 * simply appeared to do nothing.
 */
export async function updateCampaignStatus(
  campaignId: string,
  status: TablesUpdate<"campaigns">["status"]
): Promise<UpdateCampaignResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    return { ok: false, message: "Sign in to a workspace to change this campaign." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .update({ status })
    .eq("id", campaignId)
    .eq("organization_id", currentOrg.organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, message: error.message };
  }
  if (!data) {
    return { ok: false, message: "Campaign not found." };
  }

  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/campaigns");
  return { ok: true };
}

export type UpdateCampaignResult = { ok: true } | { ok: false; message: string };

/**
 * Edits a campaign's own details after it was created. The wizard writes
 * these once and previously nothing could change them again — a typo in the
 * name, or an objective that turned out wrong, was permanent.
 *
 * Scoped to the caller's organization and checked for a returned row, so a
 * campaign belonging to someone else reports "not found" rather than
 * silently reporting success against zero updated rows.
 *
 * Does not touch status (updateCampaignStatus owns that) or the linked ICP.
 */
export async function updateCampaign(
  campaignId: string,
  input: { name: string; objective: string; description: string; targetAudience: string }
): Promise<UpdateCampaignResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    return { ok: false, message: "Sign in to a workspace to edit this campaign." };
  }

  // Matches the campaigns_name_check constraint, so an empty name is
  // refused with a readable message instead of a database error.
  const name = input.name.trim();
  if (!name) {
    return { ok: false, message: "Campaign name is required." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .update({
      name,
      objective: input.objective.trim() || null,
      description: input.description.trim() || null,
      target_audience: input.targetAudience.trim() || null,
    })
    .eq("id", campaignId)
    .eq("organization_id", currentOrg.organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, message: error.message };
  }
  if (!data) {
    return { ok: false, message: "Campaign not found." };
  }

  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/campaigns");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Lead Discovery orchestration. Discovery's own job (src/lib/ai/agents/discovery.ts)
// ends at a list of DiscoveredProspect for ONE search pass — runBatchedDiscovery
// (discovery-batch.ts) calls it as many times as it takes to reach a real
// target, persisting each batch's valid prospects/leads immediately.
//
// Research starts the moment a lead is persisted, not after the whole
// discovery run finishes: a bounded worker pool (lead-worker-pool.ts) is
// created before discovery even begins, discovery's own onLeadPersisted
// callback feeds it leads live, and it runs concurrently with whatever
// batch discovery calls next.
//
//   batched discovery ──┬─→ persist lead A ─→ pool.enqueue(A) ─┐
//                        ├─→ persist lead B ─→ pool.enqueue(B) ─┤ concurrent
//                        └─→ persist lead C ─→ pool.enqueue(C) ─┘ (bounded)
//                                                                    ↓
//                              Research → Qualification → automatic outreach
//
// Qualification never runs on discovery evidence alone. The pool calls the
// exact same shared per-lead functions (researchLead/qualifyLead,
// lib/pipeline/lead-pipeline.ts) that back the manual "Run AI Research"/
// "Run Qualification" buttons, so a newly discovered lead is scored only
// once real research evidence exists for it. A lead this run's own shared
// time budget doesn't reach stays "pending" — not lost, not silently
// dropped — and the next hourly cron tick (or a human opening the lead)
// finishes it, exactly like any other pending lead.
// ---------------------------------------------------------------------------

export type { DiscoveredProspectSummary };

export type LeadDiscoveryActionResult =
  | {
      ok: true;
      status: "completed" | "partially_completed";
      prospectsFound: number;
      newLeadsCreated: number;
      duplicatesSkipped: number;
      batchesRun: number;
      stoppedReason: BatchDiscoveryStopReason;
      queriesRun: string[];
      queriesFailed: string[];
      prospects: DiscoveredProspectSummary[];
      research: DiscoveryResearchSummary;
      instagram: InstagramEnrichmentSummary;
    }
  | {
      ok: false;
      code: "unauthorized" | "no_icp" | "already_running" | "not_configured" | "provider_error";
      message: string;
      /** How many discover() batches were actually attempted before giving up — present whenever the failure came from runBatchedDiscovery itself, so a totally-failed run's history still says how much was genuinely tried. */
      batchesRun?: number;
      queriesFailed?: string[];
    };

export type DiscoveryResearchSummary = {
  /** Leads this run actually finished researching + attempting qualification for (the worker pool's own "finished" count). */
  finished: number;
  /** Leads this run genuinely attempted and failed — recorded, not retried automatically; see the lead's own research_error. */
  failed: number;
  /** Still "pending"/"researching" once this run's own shared time budget ran out — some just discovered, possibly some older — picked up automatically by the next hourly cron tick, or by opening the lead. */
  stillPending: number;
  outreach: OutreachSweepSummary;
};

/**
 * Total budget for the whole request. The platform kills a serverless
 * function at 300s; this leaves real margin rather than assuming every
 * millisecond of it is usable.
 */
const TOTAL_REQUEST_BUDGET_MS = 270_000;

/**
 * How long a "running" discovery run can sit before the duplicate-run guard
 * stops believing it. Comfortably longer than the 300s a request can
 * possibly take, so it never releases a genuinely live run — it only clears
 * one that died without writing a terminal status.
 */
const STALE_RUN_AFTER_MS = 15 * 60 * 1000;

export async function startLeadDiscoveryAction(campaignId: string): Promise<LeadDiscoveryActionResult> {
  // Budget the whole request, not just the follow-up loop — discovery and
  // extraction have already spent ~45s by the time the loop starts.
  const startedAtMs = Date.now();
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    return { ok: false, code: "unauthorized", message: "Sign in to a workspace to run lead discovery." };
  }

  const supabase = await createClient();

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, name, objective, ideal_customer_profile_id")
    .eq("id", campaignId)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!campaign) {
    return { ok: false, code: "unauthorized", message: "Campaign not found." };
  }

  // Discovery must use the campaign's actual saved ICP — never invented data.
  const icpCriteria = campaign.ideal_customer_profile_id
    ? ((await supabase.from("ideal_customer_profiles").select("criteria").eq("id", campaign.ideal_customer_profile_id).maybeSingle()).data
        ?.criteria as Record<string, unknown> | null)
    : null;

  if (!icpCriteria || Object.keys(icpCriteria).length === 0) {
    return {
      ok: false,
      code: "no_icp",
      message: "This campaign has no Ideal Customer Profile yet — generate or save an ICP before running Lead Discovery.",
    };
  }

  // Duplicate-run guard: refuse to start a second discovery run for this
  // campaign while one is already in flight.
  const { data: runningRuns } = await supabase
    .from("agent_runs")
    .select("input, started_at")
    .eq("organization_id", currentOrg.organizationId)
    .eq("agent_type", "lead_discovery")
    .eq("status", "running");

  const alreadyRunning = (runningRuns ?? []).some((r) => {
    if ((r.input as { campaignId?: string } | null)?.campaignId !== campaignId) return false;

    // A run killed mid-flight — function timeout, deploy, crash — never gets
    // its terminal status written and would otherwise hold this lock
    // forever, permanently blocking discovery for the campaign with no way
    // back from the UI. Past the stale window, treat it as dead and let a
    // new run proceed.
    const startedAt = r.started_at ? Date.parse(r.started_at) : NaN;
    if (!Number.isNaN(startedAt) && Date.now() - startedAt > STALE_RUN_AFTER_MS) return false;

    return true;
  });
  if (alreadyRunning) {
    return { ok: false, code: "already_running", message: "A discovery run is already in progress for this campaign." };
  }

  const agentRun = await createAgentRun(currentOrg.organizationId, "lead_discovery", { campaignId } as unknown as Json);
  // Pressing Start also starts the recurring cycle: this run marks the
  // campaign as running, and whatever it finds (or fails on) books the next
  // run about an hour out. A user who only ever presses the button once still
  // gets exactly the run they asked for — the schedule is what happens after.
  await markDiscoveryRunning(supabase, campaignId, currentOrg.organizationId);

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  // Bounded worker pool, created before discovery even starts — see
  // lead-worker-pool.ts. Discovery's own onLeadPersisted callback feeds it
  // leads live as each one is saved, so research on lead A is already
  // running while discovery is still out fetching/persisting lead B/C, not
  // queued up to be worked through only after the whole run finishes.
  // Seeded with this campaign's existing backlog too (leads an earlier run's
  // own budget didn't reach), so a fresh Start Discovery press also makes
  // progress on those, not just what it discovers this time.
  const pool = createLeadWorkerPool({ supabase, organizationId: currentOrg.organizationId, startedAtMs, budgetMs: TOTAL_REQUEST_BUDGET_MS });
  const { data: backlogLeads } = await supabase
    .from("leads")
    .select("id")
    .eq("organization_id", currentOrg.organizationId)
    .eq("campaign_id", campaignId)
    .eq("qualification_status", "pending")
    .neq("research_status", "failed")
    .neq("research_status", "researching")
    .order("created_at", { ascending: true });
  for (const lead of backlogLeads ?? []) pool.enqueue(lead.id);

  // Batched (see discovery-batch.ts): keeps calling discover() — each time
  // asking Nemotron/Groq to avoid the queries already tried — until it hits
  // a real target, runs out of its own time slice, or two batches in a row
  // turn up nothing genuinely new. A single batch's own provider error never
  // throws away an earlier batch's already-persisted leads. No client is
  // passed through here (unlike the scheduled path) — this call already runs
  // inside a real signed-in session, so the default cookie-based client
  // already satisfies RLS for every AI stage's own telemetry.
  //
  // Discovery and research now share one clock/budget rather than splitting
  // it into two sequential phases — they are concurrent workloads against
  // one shared deadline, not competitors for separate slices of it.
  const result = await runBatchedDiscovery({
    supabase,
    organizationId: currentOrg.organizationId,
    campaignId,
    campaignName: campaign.name,
    campaignObjective: campaign.objective,
    icpCriteria,
    businessContext: selectDiscoveryContext(businessContext),
    startedAtMs,
    budgetMs: TOTAL_REQUEST_BUDGET_MS,
    agentRun,
    onLeadPersisted: (leadId) => pool.enqueue(leadId),
  });

  // Whatever the pool couldn't start or finish within the shared budget is
  // left exactly as researchLead/qualifyLead left it (or untouched, if
  // never reached) — not lost, picked up automatically by the next hourly
  // cron tick, or by opening the lead.
  await pool.drain();

  if (!result.ok) {
    await completeAgentRun(
      agentRun,
      "failed",
      { code: result.code, message: result.message, batchesRun: result.batchesRun, queriesFailed: result.queriesFailed } as unknown as Json
    );
    await markDiscoveryFinished(supabase, campaignId, currentOrg.organizationId, { ok: false, error: result.message });
    return { ok: false, code: result.code, message: result.message, batchesRun: result.batchesRun, queriesFailed: result.queriesFailed };
  }

  const research = { finished: pool.summary.finished, failed: pool.summary.failed, outreach: pool.summary.outreach };

  const { count: stillPending } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", currentOrg.organizationId)
    .eq("campaign_id", campaignId)
    .eq("qualification_status", "pending")
    .neq("research_status", "failed");

  const researchSummary: DiscoveryResearchSummary = {
    finished: research.finished,
    failed: research.failed,
    stillPending: stillPending ?? 0,
    outreach: research.outreach,
  };

  const finalStatus: "completed" | "partially_completed" =
    result.queriesFailed.length > 0 || result.stoppedReason === "provider_error" ? "partially_completed" : "completed";
  await completeAgentRun(agentRun, finalStatus, {
    batchesRun: result.batchesRun,
    stoppedReason: result.stoppedReason,
    research: researchSummary,
    prospectsFound: result.prospectsFound,
    newLeadsCreated: result.newLeadsCreated,
    duplicatesSkipped: result.duplicatesSkipped,
    queriesRun: result.queriesRun,
    queriesFailed: result.queriesFailed,
    telemetry: result.batchTelemetry,
    instagram: result.instagram,
  } as unknown as Json);

  // Books the next run in this campaign's single schedule slot — see
  // discovery-schedule.ts. Two runs finishing at once overwrite one slot
  // rather than queueing two jobs, so this cannot double-schedule.
  await markDiscoveryFinished(supabase, campaignId, currentOrg.organizationId, { ok: true });

  revalidatePath(`/campaigns/${campaignId}`);

  return {
    ok: true,
    status: finalStatus,
    prospectsFound: result.prospectsFound,
    newLeadsCreated: result.newLeadsCreated,
    duplicatesSkipped: result.duplicatesSkipped,
    batchesRun: result.batchesRun,
    stoppedReason: result.stoppedReason,
    queriesRun: result.queriesRun,
    queriesFailed: result.queriesFailed,
    prospects: result.createdProspects,
    research: researchSummary,
    instagram: result.instagram,
  };
}

// ---------------------------------------------------------------------------
// Recurring discovery controls. Discovery repeats about hourly while a
// campaign is active (see discovery-schedule.ts and the cron sweep); these are
// the two buttons that turn that cycle off and back on.
// ---------------------------------------------------------------------------

export type DiscoveryScheduleView = {
  state: "running" | "scheduled" | "stopped" | "completed" | "failed";
  nextRunAt: string | null;
  /** Whole minutes until the next run — null when nothing is scheduled. */
  minutesUntilNextRun: number | null;
  lastRunAt: string | null;
  lastError: string | null;
};

export type DiscoveryControlResult = { ok: true; schedule: DiscoveryScheduleView } | { ok: false; message: string };

async function readSchedule(campaignId: string): Promise<DiscoveryScheduleView | null> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const schedule = await getCampaignDiscoverySchedule(supabase, campaignId, currentOrg.organizationId);
  return schedule ? toScheduleView(schedule) : null;
}

function toScheduleView(schedule: CampaignDiscoverySchedule): DiscoveryScheduleView {
  return {
    state: schedule.state,
    nextRunAt: schedule.nextRunAt,
    minutesUntilNextRun: minutesUntilNextRun(schedule.nextRunAt),
    lastRunAt: schedule.lastRunAt,
    lastError: schedule.lastError,
  };
}

/**
 * Stop Discovery. Clears the campaign's pending schedule slot, so the sweep
 * skips it entirely — this prevents future runs rather than merely hiding
 * them. A run already in flight finishes the work it started (its results are
 * real and already partly saved) but will not book another one, because
 * markDiscoveryFinished refuses to revive a stopped campaign.
 */
export async function stopLeadDiscoveryAction(campaignId: string): Promise<DiscoveryControlResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to change discovery." };

  const supabase = await createClient();
  const stopped = await stopCampaignDiscovery(supabase, campaignId, currentOrg.organizationId);
  if (!stopped) return { ok: false, message: "Campaign not found." };

  revalidatePath(`/campaigns/${campaignId}`);

  const schedule = await readSchedule(campaignId);
  return schedule ? { ok: true, schedule } : { ok: false, message: "Campaign not found." };
}

/** Resume Discovery. Books the campaign as due now, so the next sweep picks it up. */
export async function resumeLeadDiscoveryAction(campaignId: string): Promise<DiscoveryControlResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to change discovery." };

  const supabase = await createClient();
  const resumed = await resumeCampaignDiscovery(supabase, campaignId, currentOrg.organizationId);
  if (!resumed) return { ok: false, message: "Campaign not found." };

  revalidatePath(`/campaigns/${campaignId}`);

  const schedule = await readSchedule(campaignId);
  return schedule ? { ok: true, schedule } : { ok: false, message: "Campaign not found." };
}

export type ToggleWhatsAppAutoOutreachResult = { ok: true; enabled: boolean } | { ok: false; message: string };

/**
 * Per-campaign kill switch for automatic WhatsApp outreach (see
 * selectOutreachChannel / sendAutomaticWhatsAppOutreach in
 * lib/pipeline/lead-pipeline.ts) — lets an org keep WhatsApp connected and
 * used for other campaigns while opting one specific campaign out. Never
 * affects Gmail, discovery, research, or qualification; a paused/archived
 * campaign already never reaches this at all (see findEligibleCampaigns).
 */
export async function toggleWhatsAppAutoOutreachAction(campaignId: string, enabled: boolean): Promise<ToggleWhatsAppAutoOutreachResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to change this." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("campaigns")
    .update({ whatsapp_auto_outreach_enabled: enabled })
    .eq("id", campaignId)
    .eq("organization_id", currentOrg.organizationId);

  if (error) return { ok: false, message: error.message };

  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true, enabled };
}

export async function getDiscoveryScheduleAction(campaignId: string): Promise<DiscoveryScheduleView | null> {
  return readSchedule(campaignId);
}

/** The last completed/failed run's own reported totals — written once, at the end of that run. */
export type DiscoveryRunOutputSummary = {
  prospectsFound: number;
  newLeadsCreated: number;
  duplicatesSkipped: number;
  batchesRun: number;
  stoppedReason: string;
  research: DiscoveryResearchSummary | null;
};

export type DiscoveryProgress = {
  /** null when this campaign has never been run. */
  status: "running" | "completed" | "partially_completed" | "failed" | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Total leads on this campaign right now — grows live while a run is in flight, since leads are persisted as soon as each batch is discovered. */
  leadsCreated: number;
  /** Currently being researched (research_status = "researching") — a live, moment-in-time count, not the finished run's own totals. */
  researching: number;
  /** Research finished successfully (research_status = "completed"). */
  researched: number;
  /** Research genuinely failed and is not being silently retried (research_status = "failed"); see the lead's own research_error. */
  researchFailed: number;
  /** Discovered but not yet picked up for research — waiting for this run's own budget, or the next hourly cron tick. */
  waitingForResearch: number;
  scored: number;
  /** The most recent run's own reported totals, once it has a terminal status — null while still running or if it has none yet. */
  discovery: DiscoveryRunOutputSummary | null;
  message: string | null;
  /** The recurring cycle's current state, polled alongside progress so Stop/Resume and "next run" stay live in every open tab. */
  schedule: DiscoveryScheduleView | null;
};

/**
 * A light status poll for a campaign's discovery run.
 *
 * A run keeps going on the server after the browser that started it goes
 * away — the work is server-side and does not depend on the request staying
 * open. What was missing was any way to watch it: a user who closed the tab
 * had no way to see progress or learn that the run had finished. This is
 * what the Lead Discovery tab polls to answer both.
 *
 * Counts come from the rows themselves rather than the run's output, since
 * output is only written once the run ends — while it is still going, the
 * rows are the only live signal.
 */
export async function getLeadDiscoveryProgressAction(campaignId: string): Promise<DiscoveryProgress> {
  const empty: DiscoveryProgress = {
    status: null,
    startedAt: null,
    completedAt: null,
    leadsCreated: 0,
    researching: 0,
    researched: 0,
    researchFailed: 0,
    waitingForResearch: 0,
    scored: 0,
    discovery: null,
    message: null,
    schedule: null,
  };

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return empty;

  const supabase = await createClient();
  const scheduleRow = await getCampaignDiscoverySchedule(supabase, campaignId, currentOrg.organizationId);
  const schedule = scheduleRow ? toScheduleView(scheduleRow) : null;

  const [run, leadRows] = await Promise.all([
    supabase
      .from("agent_runs")
      .select("status, started_at, completed_at, output")
      .eq("organization_id", currentOrg.organizationId)
      .eq("agent_type", "lead_discovery")
      .contains("input", { campaignId })
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("leads").select("id, qualification_status, research_status").eq("campaign_id", campaignId),
  ]);

  // A campaign with no run yet still has a schedule to report — that is how
  // the tab can offer Stop before the first manual run has ever happened.
  if (!run.data) return { ...empty, schedule };

  const leads = leadRows.data ?? [];

  const output = (run.data.output ?? null) as {
    prospectsFound?: number;
    newLeadsCreated?: number;
    duplicatesSkipped?: number;
    batchesRun?: number;
    stoppedReason?: string;
    research?: DiscoveryResearchSummary;
    message?: string;
  } | null;

  // batchesRun only appears on a run that reached the new batched-discovery
  // path's own terminal write — never invented for a run still in flight or
  // one that failed before getting there.
  const discovery: DiscoveryRunOutputSummary | null =
    output && output.batchesRun !== undefined
      ? {
          prospectsFound: output.prospectsFound ?? 0,
          newLeadsCreated: output.newLeadsCreated ?? 0,
          duplicatesSkipped: output.duplicatesSkipped ?? 0,
          batchesRun: output.batchesRun,
          stoppedReason: output.stoppedReason ?? "unknown",
          research: output.research ?? null,
        }
      : null;

  return {
    status: run.data.status as DiscoveryProgress["status"],
    startedAt: run.data.started_at,
    completedAt: run.data.completed_at,
    leadsCreated: leads.length,
    researching: leads.filter((l) => l.research_status === "researching").length,
    researched: leads.filter((l) => l.research_status === "completed").length,
    researchFailed: leads.filter((l) => l.research_status === "failed").length,
    waitingForResearch: leads.filter((l) => l.research_status === "pending" || l.research_status === null).length,
    scored: leads.filter((l) => l.qualification_status !== "pending").length,
    discovery,
    message: output?.message ?? null,
    schedule,
  };
}

export type DiscoveredLeadRow = {
  leadId: string;
  leadStatus: string;
  /** "pending" / "researching" / "completed" / "failed" — see researchLead (lead-pipeline.ts). Drives the lifecycle badge: a lead that hasn't reached "completed" yet must never be shown with a confidence label. */
  researchStatus: string;
  qualificationStatus: string;
  companyName: string | null;
  website: string | null;
  location: string | null;
  industry: string | null;
  sourceUrl: string | null;
  evidenceSnippet: string | null;
  discoveredAt: string | null;
};

export async function getLeadDiscoveryStateAction(campaignId: string): Promise<{
  lastRun: { status: string; startedAt: string | null; completedAt: string | null; output: Json } | null;
  discoveredLeads: DiscoveredLeadRow[];
  schedule: DiscoveryScheduleView | null;
}> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { lastRun: null, discoveredLeads: [], schedule: null };

  const supabase = await createClient();
  const scheduleRow = await getCampaignDiscoverySchedule(supabase, campaignId, currentOrg.organizationId);

  const [lastRun, discoverySource] = await Promise.all([
    // Matched on campaignId in the query rather than by fetching a page of
    // the organization's runs and filtering here. The old version took the
    // 20 most recent runs across every campaign and then looked for this
    // one, so once other campaigns had pushed 20 runs in front of it, this
    // campaign's last run silently disappeared from the page.
    supabase
      .from("agent_runs")
      .select("status, started_at, completed_at, output")
      .eq("organization_id", currentOrg.organizationId)
      .eq("agent_type", "lead_discovery")
      .contains("input", { campaignId })
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("lead_sources")
      .select("id")
      .eq("organization_id", currentOrg.organizationId)
      .eq("type", "ai_discovery")
      .maybeSingle(),
  ]);

  const lastRunForCampaign = lastRun.data;

  let discoveredLeads: DiscoveredLeadRow[] = [];
  if (discoverySource.data) {
    const { data: leadRows } = await supabase
      .from("leads")
      .select("id, status, research_status, qualification_status, prospect_id, created_at")
      .eq("organization_id", currentOrg.organizationId)
      .eq("campaign_id", campaignId)
      .eq("lead_source_id", discoverySource.data.id)
      .order("created_at", { ascending: false });

    const prospectIds = (leadRows ?? []).map((l) => l.prospect_id).filter((id): id is string => Boolean(id));
    const { data: prospectRows } = prospectIds.length
      ? await supabase.from("prospects").select("id, company_name, website, raw_data").in("id", prospectIds)
      : { data: [] as { id: string; company_name: string | null; website: string | null; raw_data: Json }[] };

    const prospectById = new Map((prospectRows ?? []).map((p) => [p.id, p]));

    discoveredLeads = (leadRows ?? []).map((lead) => {
      const prospect = lead.prospect_id ? prospectById.get(lead.prospect_id) : undefined;
      const rawData = (prospect?.raw_data ?? {}) as Record<string, unknown>;
      return {
        leadId: lead.id,
        leadStatus: lead.status,
        researchStatus: lead.research_status,
        qualificationStatus: lead.qualification_status,
        companyName: prospect?.company_name ?? null,
        website: prospect?.website ?? null,
        location: typeof rawData.location === "string" ? rawData.location : null,
        industry: typeof rawData.industry === "string" ? rawData.industry : null,
        sourceUrl: typeof rawData.sourceUrl === "string" ? rawData.sourceUrl : null,
        evidenceSnippet: typeof rawData.evidenceSnippet === "string" ? rawData.evidenceSnippet : null,
        discoveredAt: typeof rawData.discoveredAt === "string" ? rawData.discoveredAt : lead.created_at,
      };
    });
  }

  return {
    lastRun: lastRunForCampaign
      ? {
          status: lastRunForCampaign.status,
          startedAt: lastRunForCampaign.started_at,
          completedAt: lastRunForCampaign.completed_at,
          output: lastRunForCampaign.output,
        }
      : null,
    discoveredLeads,
    schedule: scheduleRow ? toScheduleView(scheduleRow) : null,
  };
}
