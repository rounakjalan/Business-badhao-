import { LeadsListClient } from "@/app/(dashboard)/leads/leads-list-client";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function LeadsPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, status, qualification_status, current_score, intent, next_action, campaign_id, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  const leadIds = (leads ?? []).map((l) => l.id);
  const campaignIds = [...new Set((leads ?? []).map((l) => l.campaign_id).filter((id): id is string => Boolean(id)))];

  const [contacts, campaigns] = await Promise.all([
    leadIds.length
      ? supabase.from("contacts").select("lead_id, full_name, email").in("lead_id", leadIds).eq("is_primary", true)
      : Promise.resolve({ data: [] }),
    campaignIds.length ? supabase.from("campaigns").select("id, name").in("id", campaignIds) : Promise.resolve({ data: [] }),
  ]);

  const contactByLead = new Map((contacts.data ?? []).map((c) => [c.lead_id, c]));
  const campaignNameById = new Map((campaigns.data ?? []).map((c) => [c.id, c.name]));

  const rows = (leads ?? []).map((l) => ({
    id: l.id,
    name: contactByLead.get(l.id)?.full_name ?? "Unnamed lead",
    email: contactByLead.get(l.id)?.email ?? null,
    status: l.status,
    qualificationStatus: l.qualification_status,
    score: l.current_score,
    intent: l.intent,
    nextAction: l.next_action,
    campaignName: l.campaign_id ? (campaignNameById.get(l.campaign_id) ?? null) : null,
    createdAt: l.created_at,
  }));

  return <LeadsListClient leads={rows} />;
}
