"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ProspectResearchResult } from "@/lib/ai/agents/prospect-research";
import type { LeadQualificationResult } from "@/lib/ai/agents/qualification";
import { generateOutreach, type OutreachGeneratorResult } from "@/lib/ai/agents/outreach";
import { getBusinessContext, selectOutreachContext } from "@/lib/business-context";
import { loadLeadContext as loadSharedLeadContext, qualifyLead, researchLead } from "@/lib/pipeline/lead-pipeline";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

/** Session-scoped wrapper: the shared pipeline takes an explicit client and org. */
async function loadLeadContext(leadId: string, organizationId: string) {
  const supabase = await createClient();
  return loadSharedLeadContext(supabase, leadId, organizationId);
}

export async function runLeadResearchAction(leadId: string): Promise<ProspectResearchResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to run research." };

  const supabase = await createClient();
  const result = await researchLead(supabase, currentOrg.organizationId, leadId);
  if (result.ok) revalidatePath(`/leads/${leadId}`);
  return result;
}

export async function runLeadQualificationAction(leadId: string): Promise<LeadQualificationResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to run qualification." };

  const supabase = await createClient();
  const result = await qualifyLead(supabase, currentOrg.organizationId, leadId);
  if (result.ok) {
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
