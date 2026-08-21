"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runCampaignPlanner, type CampaignPlan, type CampaignPlannerResult } from "@/lib/ai/agents/campaign-planner";
import { getDiscoveryProvider, prospectDedupeKey } from "@/lib/ai/agents/discovery";
import { IcpSchema, runIcpGenerator, type IcpGeneratorResult } from "@/lib/ai/agents/icp-generator";
import { completeAgentRun, createAgentRun, recordAgentAction } from "@/lib/ai/tracking/agent-runs";
import { getBusinessContext, selectDiscoveryContext } from "@/lib/business-context";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Json, TablesUpdate } from "@/types/database.types";

export async function generateCampaignPlan(input: {
  name: string;
  objective: string;
  description: string;
  customerType: string;
  location: string;
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
// ends at a list of DiscoveredProspect — this function is what persists them
// as real prospects/leads and hands them to the existing Lead Research stage
// (runLeadResearchAction in leads/actions.ts, unchanged) via the created
// lead's id. Never merges qualification or research logic in here.
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
    }
  | { ok: false; code: "unauthorized" | "no_icp" | "already_running" | "not_configured" | "provider_error"; message: string };

export async function startLeadDiscoveryAction(campaignId: string): Promise<LeadDiscoveryActionResult> {
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
    .select("input")
    .eq("organization_id", currentOrg.organizationId)
    .eq("agent_type", "lead_discovery")
    .eq("status", "running");

  const alreadyRunning = (runningRuns ?? []).some(
    (r) => (r.input as { campaignId?: string } | null)?.campaignId === campaignId
  );
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
    await completeAgentRun(agentRun, "failed", { code: result.code, message: result.message } as unknown as Json);
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

  const finalStatus: "completed" | "partially_completed" = result.queriesFailed.length > 0 ? "partially_completed" : "completed";
  await completeAgentRun(agentRun, finalStatus, {
    prospectsFound: result.prospects.length,
    newLeadsCreated,
    duplicatesSkipped,
    queriesRun: result.queriesRun,
    queriesFailed: result.queriesFailed,
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
