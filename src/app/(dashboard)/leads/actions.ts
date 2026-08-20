"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runProspectResearch, type ProspectResearchResult } from "@/lib/ai/agents/prospect-research";
import { runLeadQualification, type LeadQualificationResult } from "@/lib/ai/agents/qualification";
import { generateOutreach, type OutreachGeneratorResult } from "@/lib/ai/agents/outreach";
import { getBusinessContext, selectOutreachContext, selectQualificationContext, selectResearchContext } from "@/lib/business-context";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database.types";

async function loadLeadContext(leadId: string, organizationId: string) {
  const supabase = await createClient();

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
  const leadName = primaryContact?.full_name ?? "Unnamed lead";

  return {
    lead,
    leadName,
    companyName: prospect.data?.company_name ?? null,
    website: prospect.data?.website ?? null,
    title: prospect.data?.title ?? null,
    campaignName: campaign.data?.name ?? null,
    campaignObjective: campaign.data?.objective ?? null,
    icpCriteria,
    latestResearchSummary: latestResearch.data?.summary ?? null,
  };
}

export async function runLeadResearchAction(leadId: string): Promise<ProspectResearchResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to run research." };

  const context = await loadLeadContext(leadId, currentOrg.organizationId);
  if (!context) return { ok: false, message: "Lead not found." };

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  const result = await runProspectResearch({
    organizationId: currentOrg.organizationId,
    leadName: context.leadName,
    companyName: context.companyName,
    website: context.website,
    title: context.title,
    campaignName: context.campaignName,
    campaignObjective: context.campaignObjective,
    businessContext: selectResearchContext(businessContext),
  });

  if (result.ok) {
    const supabase = await createClient();
    await supabase.from("lead_research").insert({
      organization_id: currentOrg.organizationId,
      lead_id: leadId,
      summary: result.research.companySummary,
      findings: result.research as unknown as Json,
      source: "ai",
    });
    revalidatePath(`/leads/${leadId}`);
  }

  return result;
}

export async function runLeadQualificationAction(leadId: string): Promise<LeadQualificationResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to run qualification." };

  const context = await loadLeadContext(leadId, currentOrg.organizationId);
  if (!context) return { ok: false, message: "Lead not found." };

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  const result = await runLeadQualification({
    organizationId: currentOrg.organizationId,
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
    const supabase = await createClient();
    const q = result.qualification;
    const reason = [
      q.positiveReasons.length > 0 ? `Positive: ${q.positiveReasons.join("; ")}` : null,
      q.negativeReasons.length > 0 ? `Negative: ${q.negativeReasons.join("; ")}` : null,
    ]
      .filter(Boolean)
      .join(". ");

    await supabase.from("lead_scores").insert({
      organization_id: currentOrg.organizationId,
      lead_id: leadId,
      score: Math.round(q.qualificationScore),
      reason: reason || null,
      scored_by: "agent",
    });
    await supabase
      .from("leads")
      .update({ current_score: Math.round(q.qualificationScore), qualification_status: q.recommendedStatus })
      .eq("id", leadId);

    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    revalidatePath("/dashboard");
  }

  return result;
}

export async function generateLeadOutreachAction(leadId: string, channel: string): Promise<OutreachGeneratorResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to generate outreach." };

  const context = await loadLeadContext(leadId, currentOrg.organizationId);
  if (!context) return { ok: false, message: "Lead not found." };

  const supabase = await createClient();
  const { data: latestScore } = await supabase
    .from("lead_scores")
    .select("reason")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  return generateOutreach({
    organizationId: currentOrg.organizationId,
    leadName: context.leadName,
    companyName: context.companyName,
    channel,
    campaignName: context.campaignName,
    campaignObjective: context.campaignObjective,
    researchSummary: context.latestResearchSummary,
    qualificationReasons: latestScore?.reason ? [latestScore.reason] : [],
    businessContext: selectOutreachContext(businessContext),
  });
}

export async function updateLeadNotes(leadId: string, formData: FormData) {
  const notes = String(formData.get("notes") ?? "");
  const supabase = await createClient();
  await supabase.from("leads").update({ notes }).eq("id", leadId);
  revalidatePath(`/leads/${leadId}`);
}

export async function quickCreateDealForLead(leadId: string, leadName: string) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/onboarding");

  const supabase = await createClient();
  const { data: lead } = await supabase.from("leads").select("campaign_id").eq("id", leadId).maybeSingle();

  const { data: deal, error } = await supabase
    .from("deals")
    .insert({
      organization_id: currentOrg.organizationId,
      lead_id: leadId,
      campaign_id: lead?.campaign_id ?? null,
      title: `Deal with ${leadName}`,
      status: "open",
      value: 0,
    })
    .select("id")
    .single();

  if (error || !deal) return;
  redirect(`/deals/${deal.id}`);
}

export async function quickCreateTaskForLead(leadId: string, leadName: string) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/onboarding");

  const supabase = await createClient();
  await supabase.from("tasks").insert({
    organization_id: currentOrg.organizationId,
    title: `Follow up with ${leadName}`,
    related_entity_type: "lead",
    related_entity_id: leadId,
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/tasks");
}
