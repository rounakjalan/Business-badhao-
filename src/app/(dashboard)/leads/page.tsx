import { CampaignPickerClient } from "@/app/(dashboard)/leads/campaign-picker-client";
import { LeadsListClient } from "@/app/(dashboard)/leads/leads-list-client";
import { resolveLeadIdentities } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

const UNASSIGNED_ID = "unassigned";

/**
 * Leads are organized by campaign first: this page shows a campaign picker,
 * and ?campaign=<id> drills into that campaign's own lead table (the
 * existing LeadsListClient, unchanged apart from its header). Per-campaign
 * lead counts are computed in memory from the single leads query below —
 * never a second per-campaign query — since every lead the counts need is
 * already being fetched to render the selected campaign's table anyway.
 */
export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const { campaign: selectedCampaignId } = await searchParams;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();

  const [{ data: campaigns, error: campaignsError }, { data: leads, error: leadsError }] = await Promise.all([
    supabase.from("campaigns").select("id, name, status").eq("organization_id", currentOrg.organizationId).order("created_at", { ascending: false }),
    supabase
      .from("leads")
      .select("id, status, qualification_status, current_score, intent, next_action, campaign_id, created_at")
      .eq("organization_id", currentOrg.organizationId)
      .order("created_at", { ascending: false }),
  ]);

  if (campaignsError) throw new Error(campaignsError.message);
  if (leadsError) throw new Error(leadsError.message);

  const leadRows = leads ?? [];
  const campaignRows = campaigns ?? [];

  const leadsByCampaign = new Map<string, typeof leadRows>();
  const unassignedLeads: typeof leadRows = [];
  for (const lead of leadRows) {
    if (!lead.campaign_id) {
      unassignedLeads.push(lead);
      continue;
    }
    const bucket = leadsByCampaign.get(lead.campaign_id) ?? [];
    bucket.push(lead);
    leadsByCampaign.set(lead.campaign_id, bucket);
  }

  const campaignById = new Map(campaignRows.map((c) => [c.id, c]));
  const campaignSummaries = campaignRows.map((c) => {
    const campaignLeads = leadsByCampaign.get(c.id) ?? [];
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      leadCount: campaignLeads.length,
      qualifiedCount: campaignLeads.filter((l) => l.qualification_status === "qualified").length,
    };
  });

  // No selection, or an id that doesn't belong to this organization — show
  // the campaign picker rather than guessing or leaking another org's data.
  const selectedCampaign = selectedCampaignId ? campaignById.get(selectedCampaignId) : undefined;
  const selected =
    selectedCampaignId === UNASSIGNED_ID
      ? { name: "Unassigned Leads", leads: unassignedLeads }
      : selectedCampaign
        ? { name: selectedCampaign.name, leads: leadsByCampaign.get(selectedCampaign.id) ?? [] }
        : null;

  if (!selected) {
    return <CampaignPickerClient campaigns={campaignSummaries} unassignedCount={unassignedLeads.length} />;
  }

  const leadIds = selected.leads.map((l) => l.id);
  const identities = await resolveLeadIdentities(supabase, leadIds);

  const rows = selected.leads.map((l) => ({
    id: l.id,
    name: identities.get(l.id)?.name ?? "Unnamed lead",
    email: identities.get(l.id)?.email ?? null,
    status: l.status,
    qualificationStatus: l.qualification_status,
    score: l.current_score,
    intent: l.intent,
    nextAction: l.next_action,
    createdAt: l.created_at,
  }));

  return <LeadsListClient leads={rows} campaignName={selected.name} backHref="/leads" />;
}
