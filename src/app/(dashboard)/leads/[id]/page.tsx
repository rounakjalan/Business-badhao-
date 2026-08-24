import { notFound } from "next/navigation";
import { LeadDetailTabs } from "@/app/(dashboard)/leads/[id]/lead-detail-tabs";
import { getBusinessContext, isBusinessContextEmpty } from "@/lib/business-context";
import { getConnectionStatus } from "@/lib/gmail/tokens";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { parseProspectRawData } from "@/lib/prospects";
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

  const [contacts, prospect, campaign, research, conversations, tasks, deals, latestScore] = await Promise.all([
    supabase.from("contacts").select("id, full_name, email, phone, role_title, is_primary").eq("lead_id", id),
    lead.prospect_id
      ? supabase.from("prospects").select("company_name, website, raw_data").eq("id", lead.prospect_id).maybeSingle()
      : Promise.resolve({ data: null }),
    lead.campaign_id ? supabase.from("campaigns").select("name").eq("id", lead.campaign_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("lead_research").select("id, summary, findings, source, created_at").eq("lead_id", id).order("created_at", { ascending: false }),
    supabase.from("conversations").select("id, channel, status, created_at").eq("lead_id", id).order("created_at", { ascending: false }),
    supabase.from("tasks").select("id, title, status, due_at").eq("related_entity_type", "lead").eq("related_entity_id", id).order("created_at", { ascending: false }),
    supabase.from("deals").select("id, title, status, value, currency").eq("lead_id", id).order("created_at", { ascending: false }),
    supabase.from("lead_scores").select("reason, created_at").eq("lead_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const primaryContact = contacts.data?.find((c) => c.is_primary) ?? contacts.data?.[0] ?? null;
  const prospectDiscovery = parseProspectRawData(prospect.data?.raw_data);

  // The send action resolves a recipient the same way (contact -> prospect,
  // never fabricated) — this must agree with what Contact Information and
  // the outreach panel display, or the UI could show "no email" while a
  // send would actually find one, or the reverse.
  const [identity, gmailStatus, businessContext] = await Promise.all([
    resolveLeadIdentity(supabase, id),
    getConnectionStatus(currentOrg.organizationId),
    getBusinessContext(currentOrg.organizationId, supabase),
  ]);
  const recipientEmail = identity.email;

  return (
    <LeadDetailTabs
      lead={lead}
      leadName={primaryContact?.full_name ?? prospect.data?.company_name ?? "Unnamed lead"}
      primaryContact={primaryContact}
      recipientEmail={recipientEmail}
      gmailStatus={gmailStatus}
      hasBusinessKnowledge={!isBusinessContextEmpty(businessContext)}
      contacts={contacts.data ?? []}
      companyName={prospect.data?.company_name ?? null}
      website={prospect.data?.website ?? null}
      discovery={prospectDiscovery}
      campaignName={campaign.data?.name ?? null}
      latestQualificationReason={latestScore.data?.reason ?? null}
      research={research.data ?? []}
      conversations={conversations.data ?? []}
      tasks={tasks.data ?? []}
      deals={deals.data ?? []}
    />
  );
}
