import { notFound } from "next/navigation";
import { LeadDetailTabs } from "@/app/(dashboard)/leads/[id]/lead-detail-tabs";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data: lead } = await supabase
    .from("leads")
    .select("id, status, qualification_status, current_score, intent, next_action, notes, prospect_id, campaign_id, created_at")
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!lead) notFound();

  const [contacts, prospect, campaign, research, conversations, tasks, deals] = await Promise.all([
    supabase.from("contacts").select("id, full_name, email, phone, role_title, is_primary").eq("lead_id", id),
    lead.prospect_id
      ? supabase.from("prospects").select("company_name, website").eq("id", lead.prospect_id).maybeSingle()
      : Promise.resolve({ data: null }),
    lead.campaign_id ? supabase.from("campaigns").select("name").eq("id", lead.campaign_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("lead_research").select("id, summary, source, created_at").eq("lead_id", id).order("created_at", { ascending: false }),
    supabase.from("conversations").select("id, channel, status, created_at").eq("lead_id", id).order("created_at", { ascending: false }),
    supabase.from("tasks").select("id, title, status, due_at").eq("related_entity_type", "lead").eq("related_entity_id", id).order("created_at", { ascending: false }),
    supabase.from("deals").select("id, title, status, value, currency").eq("lead_id", id).order("created_at", { ascending: false }),
  ]);

  const primaryContact = contacts.data?.find((c) => c.is_primary) ?? contacts.data?.[0] ?? null;

  return (
    <LeadDetailTabs
      lead={lead}
      leadName={primaryContact?.full_name ?? prospect.data?.company_name ?? "Unnamed lead"}
      primaryContact={primaryContact}
      contacts={contacts.data ?? []}
      companyName={prospect.data?.company_name ?? null}
      website={prospect.data?.website ?? null}
      campaignName={campaign.data?.name ?? null}
      research={research.data ?? []}
      conversations={conversations.data ?? []}
      tasks={tasks.data ?? []}
      deals={deals.data ?? []}
    />
  );
}
