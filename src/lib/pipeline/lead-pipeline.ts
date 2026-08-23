import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runProspectResearch, type ProspectResearchResult } from "@/lib/ai/agents/prospect-research";
import { runLeadQualification, type LeadQualificationResult } from "@/lib/ai/agents/qualification";
import { getBusinessContext, selectQualificationContext, selectResearchContext } from "@/lib/business-context";
import type { Database, Json } from "@/types/database.types";

type Client = SupabaseClient<Database>;

/**
 * The per-lead half of the pipeline — research, then qualification —
 * expressed without any dependency on who is signed in.
 *
 * The Server Actions behind the Research and Qualify buttons resolve the
 * organization from the session and then call these. Scheduled work has no
 * session and passes the organization it already knows. Keeping one
 * implementation matters more than usual here: the rule that qualification
 * only runs on real research evidence lives in this path, and two copies
 * would eventually disagree about it.
 *
 * Every query is scoped by organization_id explicitly, because a caller may
 * be using a client that bypasses row-level security.
 */

export async function loadLeadContext(supabase: Client, leadId: string, organizationId: string) {
  const { data: lead } = await supabase
    .from("leads")
    .select("id, status, qualification_status, current_score, campaign_id, prospect_id")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!lead) return null;

  const [contacts, prospect, campaign, latestResearch] = await Promise.all([
    supabase.from("contacts").select("full_name, is_primary").eq("lead_id", leadId),
    lead.prospect_id
      ? supabase.from("prospects").select("company_name, website, title").eq("id", lead.prospect_id).maybeSingle()
      : Promise.resolve({ data: null }),
    lead.campaign_id
      ? supabase.from("campaigns").select("name, objective, ideal_customer_profile_id").eq("id", lead.campaign_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("lead_research")
      .select("summary")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  let icpCriteria: Record<string, unknown> | null = null;
  if (campaign.data?.ideal_customer_profile_id) {
    const { data: icp } = await supabase
      .from("ideal_customer_profiles")
      .select("criteria")
      .eq("id", campaign.data.ideal_customer_profile_id)
      .maybeSingle();
    icpCriteria = (icp?.criteria as Record<string, unknown> | null) ?? null;
  }

  const primaryContact = contacts.data?.find((c) => c.is_primary) ?? contacts.data?.[0] ?? null;

  return {
    lead,
    leadName: primaryContact?.full_name ?? "Unnamed lead",
    companyName: prospect.data?.company_name ?? null,
    website: prospect.data?.website ?? null,
    title: prospect.data?.title ?? null,
    campaignName: campaign.data?.name ?? null,
    campaignObjective: campaign.data?.objective ?? null,
    icpCriteria,
    latestResearchSummary: latestResearch.data?.summary ?? null,
  };
}

export async function researchLead(
  supabase: Client,
  organizationId: string,
  leadId: string
): Promise<ProspectResearchResult> {
  const context = await loadLeadContext(supabase, leadId, organizationId);
  if (!context) return { ok: false, message: "Lead not found." };

  const businessContext = await getBusinessContext(organizationId, supabase);

  const result = await runProspectResearch({
    organizationId,
    leadName: context.leadName,
    companyName: context.companyName,
    website: context.website,
    title: context.title,
    campaignName: context.campaignName,
    campaignObjective: context.campaignObjective,
    businessContext: selectResearchContext(businessContext),
  });

  if (result.ok) {
    await supabase.from("lead_research").insert({
      organization_id: organizationId,
      lead_id: leadId,
      summary: result.research.companySummary,
      findings: result.research as unknown as Json,
      source: "ai",
    });
  }

  return result;
}

export async function qualifyLead(
  supabase: Client,
  organizationId: string,
  leadId: string
): Promise<LeadQualificationResult> {
  const context = await loadLeadContext(supabase, leadId, organizationId);
  if (!context) return { ok: false, message: "Lead not found." };

  const businessContext = await getBusinessContext(organizationId, supabase);

  const result = await runLeadQualification({
    organizationId,
    leadName: context.leadName,
    companyName: context.companyName,
    currentStatus: context.lead.qualification_status,
    currentScore: context.lead.current_score,
    researchSummary: context.latestResearchSummary,
    icpCriteria: context.icpCriteria,
    campaignObjective: context.campaignObjective,
    businessContext: selectQualificationContext(businessContext),
  });

  if (result.ok) {
    const q = result.qualification;
    const reason = [
      q.positiveReasons.length > 0 ? `Positive: ${q.positiveReasons.join("; ")}` : null,
      q.negativeReasons.length > 0 ? `Negative: ${q.negativeReasons.join("; ")}` : null,
    ]
      .filter(Boolean)
      .join(". ");

    await supabase.from("lead_scores").insert({
      organization_id: organizationId,
      lead_id: leadId,
      score: Math.round(q.qualificationScore),
      reason: reason || null,
      scored_by: "agent",
    });
    await supabase
      .from("leads")
      .update({ current_score: Math.round(q.qualificationScore), qualification_status: q.recommendedStatus })
      .eq("id", leadId)
      .eq("organization_id", organizationId);
  }

  return result;
}
