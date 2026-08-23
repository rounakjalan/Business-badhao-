"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runCampaignPlanner, type CampaignPlan, type CampaignPlannerResult } from "@/lib/ai/agents/campaign-planner";
import { getDiscoveryProvider, prospectDedupeKey } from "@/lib/ai/agents/discovery";
import { IcpSchema, runIcpGenerator, type IcpGeneratorResult } from "@/lib/ai/agents/icp-generator";
import { completeAgentRun, createAgentRun, recordAgentAction } from "@/lib/ai/tracking/agent-runs";
import { getBusinessContext, selectDiscoveryContext } from "@/lib/business-context";
import { runLeadResearchAction, runLeadQualificationAction } from "@/app/(dashboard)/leads/actions";
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

export async function updateCampaignStatus(campaignId: string, status: TablesUpdate<"campaigns">["status"]) {
  const supabase = await createClient();
  await supabase.from("campaigns").update({ status }).eq("id", campaignId);
  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/campaigns");
}

// ---------------------------------------------------------------------------
// Lead Discovery orchestration. Discovery's own job (src/lib/ai/agents/discovery.ts)
// ends at a list of DiscoveredProspect — this function persists them as real
// prospects/leads, then runs each one through the rest of the pipeline in
// order (see runResearchAndQualification below):
//
//   discovery -> persist prospect/lead -> Lead Research -> Qualification
//
// Qualification never runs on discovery evidence alone. It reuses the exact
// same per-lead actions a user triggers by hand from a lead's page
// (runLeadResearchAction / runLeadQualificationAction, leads/actions.ts), so
// a newly discovered lead is scored only once real research evidence exists
// for it — runLeadQualification's own clampWithoutResearchEvidence guard
// (qualification.ts) additionally refuses to finalize "qualified"/
// "disqualified" without it. A lead whose research fails or is skipped
// simply stays at "pending" for later, exactly as a lead created any other
// way would.
// ---------------------------------------------------------------------------

export type DiscoveredProspectSummary = {
  companyName: string;
  website: string | null;
  location: string | null;
  industry: string | null;
  sourceUrl: string;
  evidenceSnippet: string;
  matchedIcpCriteria: string[];
};

export type LeadDiscoveryActionResult =
  | {
      ok: true;
      status: "completed" | "partially_completed";
      prospectsFound: number;
      newLeadsCreated: number;
      duplicatesSkipped: number;
      queriesRun: string[];
      queriesFailed: string[];
      prospects: DiscoveredProspectSummary[];
      followUp: DiscoveryFollowUpSummary;
    }
  | { ok: false; code: "unauthorized" | "no_icp" | "already_running" | "not_configured" | "provider_error"; message: string };

export type DiscoveryFollowUpSummary = {
  researchAttempted: number;
  researchSucceeded: number;
  researchFailed: number;
  qualified: number;
  disqualified: number;
  /** Left "pending"/"qualifying" — research failed, or research succeeded but the evidence wasn't enough to finalize a verdict. */
  qualifying: number;
  /** Discovered and saved, but not researched in this run because it ran out of time budget. They stay "pending" and can be picked up per-lead. */
  deferred: number;
};

/**
 * How much of the request to spend starting new leads.
 *
 * The platform kills a serverless function at 300s. Research plus
 * qualification for a single lead measured ~48s against the real providers,
 * so a run that discovers more than a handful of leads cannot finish them
 * all in one request — an 8-lead run needs ~430s. Left unbounded it dies at
 * the ceiling: the response is lost, the agent run is never closed out, and
 * the leads it never reached sit at "pending" with nothing recording why.
 *
 * So stop *starting* leads once this much of the request is gone and report
 * the rest as deferred. The worst case is one lead starting just under the
 * line and running long, which still lands well inside 300s.
 */
const FOLLOW_UP_BUDGET_MS = 225_000;

/**
 * How long a "running" discovery run can sit before the duplicate-run guard
 * stops believing it. Comfortably longer than the 300s a request can
 * possibly take, so it never releases a genuinely live run — it only clears
 * one that died without writing a terminal status.
 */
const STALE_RUN_AFTER_MS = 15 * 60 * 1000;

/**
 * Runs Lead Research, then (only on success) Qualification, for each newly
 * discovered lead — the same two per-lead actions a user can trigger by
 * hand from a lead's page. A lead whose research fails is left exactly as
 * discovery created it ("pending"); qualification is never attempted for it
 * on discovery evidence alone.
 *
 * Never fails the discovery run: the prospects/leads are already saved and
 * real, so a per-lead research or qualification failure — or running out of
 * budget before reaching a lead — is reflected in the summary counts rather
 * than throwing away a good discovery run.
 */
async function runResearchAndQualification(leadIds: string[], startedAtMs: number): Promise<DiscoveryFollowUpSummary> {
  const summary: DiscoveryFollowUpSummary = {
    researchAttempted: 0,
    researchSucceeded: 0,
    researchFailed: 0,
    qualified: 0,
    disqualified: 0,
    qualifying: 0,
    deferred: 0,
  };

  for (const [index, leadId] of leadIds.entries()) {
    if (Date.now() - startedAtMs >= FOLLOW_UP_BUDGET_MS) {
      // Out of budget. Everything from here stays "pending" — untouched and
      // still qualifiable per-lead — rather than being cut off mid-request.
      summary.deferred = leadIds.length - index;
      break;
    }

    summary.researchAttempted += 1;

    const researchResult = await runLeadResearchAction(leadId);
    if (!researchResult.ok) {
      summary.researchFailed += 1;
      continue;
    }
    summary.researchSucceeded += 1;

    const qualificationResult = await runLeadQualificationAction(leadId);
    if (!qualificationResult.ok) continue;

    const status = qualificationResult.qualification.recommendedStatus;
    if (status === "qualified") summary.qualified += 1;
    else if (status === "disqualified") summary.disqualified += 1;
    else summary.qualifying += 1;
  }

  return summary;
}

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

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  const provider = getDiscoveryProvider();
  const result = await provider.discover({
    organizationId: currentOrg.organizationId,
    campaignName: campaign.name,
    campaignObjective: campaign.objective,
    icpCriteria,
    businessContext: selectDiscoveryContext(businessContext),
  });

  if (!result.ok) {
    await completeAgentRun(agentRun, "failed", {
      code: result.code,
      message: result.message,
      telemetry: result.telemetry ?? null,
    } as unknown as Json);
    return { ok: false, code: result.code, message: result.message };
  }

  // Cross-run de-dup: skip anything already persisted for this org (any
  // campaign) under the same canonical website/company name, so re-running
  // discovery never creates duplicate prospects.
  const { data: existingProspects } = await supabase
    .from("prospects")
    .select("website, company_name")
    .eq("organization_id", currentOrg.organizationId);

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
      .eq("organization_id", currentOrg.organizationId)
      .eq("type", "ai_discovery")
      .maybeSingle();

    leadSourceId = existingSource?.id ?? null;
    if (!leadSourceId) {
      const { data: createdSource } = await supabase
        .from("lead_sources")
        .insert({ organization_id: currentOrg.organizationId, name: "AI Lead Discovery", type: "ai_discovery" })
        .select("id")
        .single();
      leadSourceId = createdSource?.id ?? null;
    }
  }

  let newLeadsCreated = 0;
  const createdProspects: DiscoveredProspectSummary[] = [];
  const newLeadIds: string[] = [];

  for (const prospect of newProspects) {
    const { data: prospectRow } = await supabase
      .from("prospects")
      .insert({
        organization_id: currentOrg.organizationId,
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
        organization_id: currentOrg.organizationId,
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
    newLeadIds.push(leadRow.id);
    createdProspects.push({
      companyName: prospect.companyName,
      website: prospect.website,
      location: prospect.location,
      industry: prospect.industry,
      sourceUrl: prospect.sourceUrl,
      evidenceSnippet: prospect.evidenceSnippet,
      matchedIcpCriteria: prospect.matchedIcpCriteria,
    });

    if (agentRun) {
      await recordAgentAction({
        organizationId: currentOrg.organizationId,
        agentRunId: agentRun.id,
        actionType: "lead_discovered",
        targetEntityType: "lead",
        targetEntityId: leadRow.id,
        payload: { companyName: prospect.companyName, sourceUrl: prospect.sourceUrl } as unknown as Json,
      });
    }
  }

  const followUpSummary = await runResearchAndQualification(newLeadIds, startedAtMs);

  const finalStatus: "completed" | "partially_completed" = result.queriesFailed.length > 0 ? "partially_completed" : "completed";
  await completeAgentRun(agentRun, finalStatus, {
    followUp: followUpSummary,
    prospectsFound: result.prospects.length,
    newLeadsCreated,
    duplicatesSkipped,
    queriesRun: result.queriesRun,
    queriesFailed: result.queriesFailed,
    telemetry: result.telemetry ?? null,
  } as unknown as Json);

  revalidatePath(`/campaigns/${campaignId}`);

  return {
    ok: true,
    status: finalStatus,
    prospectsFound: result.prospects.length,
    newLeadsCreated,
    duplicatesSkipped,
    queriesRun: result.queriesRun,
    queriesFailed: result.queriesFailed,
    prospects: createdProspects,
    followUp: followUpSummary,
  };
}

export type DiscoveredLeadRow = {
  leadId: string;
  leadStatus: string;
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
}> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { lastRun: null, discoveredLeads: [] };

  const supabase = await createClient();

  const [runs, discoverySource] = await Promise.all([
    supabase
      .from("agent_runs")
      .select("status, started_at, completed_at, output, input")
      .eq("organization_id", currentOrg.organizationId)
      .eq("agent_type", "lead_discovery")
      .order("started_at", { ascending: false })
      .limit(20),
    supabase
      .from("lead_sources")
      .select("id")
      .eq("organization_id", currentOrg.organizationId)
      .eq("type", "ai_discovery")
      .maybeSingle(),
  ]);

  const lastRunForCampaign = (runs.data ?? []).find((r) => (r.input as { campaignId?: string } | null)?.campaignId === campaignId);

  let discoveredLeads: DiscoveredLeadRow[] = [];
  if (discoverySource.data) {
    const { data: leadRows } = await supabase
      .from("leads")
      .select("id, status, prospect_id, created_at")
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
  };
}
