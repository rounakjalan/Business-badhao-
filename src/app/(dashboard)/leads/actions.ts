"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

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
