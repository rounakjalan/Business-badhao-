import { ProspectCampaignPickerClient } from "@/app/(dashboard)/prospects/campaign-picker-client";
import { ProspectLifecycleClient, type ProspectRow } from "@/app/(dashboard)/prospects/prospect-lifecycle-client";
import { classifyProspectStage } from "@/lib/prospect-lifecycle";
import { parseProspectRawData } from "@/lib/prospects";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

const UNASSIGNED_ID = "unassigned";

/**
 * Prospects are organized by campaign first, then by lifecycle stage — the
 * same shape as the Leads page (see leads/page.tsx), but one stage earlier:
 * Prospects covers discovery → research → qualification, before a prospect
 * becomes a Lead. Lifecycle stage isn't a new status column — it's derived
 * from the existing leads.research_status/qualification_status via
 * classifyProspectStage (prospect-lifecycle.ts), since every prospect this
 * page shows already has the lead record the Prospect → Lead workflow
 * creates for it.
 *
 * Three flat, org-scoped queries (campaigns, prospects, lead-lifecycle-only)
 * joined in memory — never a per-campaign or per-prospect query — so this
 * page's cost stays O(1) round trips regardless of how many campaigns or
 * prospects an organization has.
 */
export default async function ProspectsPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const { campaign: selectedCampaignId } = await searchParams;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();

  const [{ data: campaigns, error: campaignsError }, { data: prospects, error: prospectsError }, { data: leads, error: leadsError }] = await Promise.all([
    supabase.from("campaigns").select("id, name, status").eq("organization_id", currentOrg.organizationId).order("created_at", { ascending: false }),
    supabase
      .from("prospects")
      .select("id, company_name, contact_name, email, phone, website, raw_data, campaign_id, created_at")
      .eq("organization_id", currentOrg.organizationId)
      .order("created_at", { ascending: false }),
    supabase.from("leads").select("id, prospect_id, qualification_status, research_status").eq("organization_id", currentOrg.organizationId),
  ]);

  if (campaignsError) throw new Error(campaignsError.message);
  if (prospectsError) throw new Error(prospectsError.message);
  if (leadsError) throw new Error(leadsError.message);

  const campaignRows = campaigns ?? [];
  const prospectRows = prospects ?? [];
  // One lead per prospect in practice (the Prospect → Lead workflow creates
  // exactly one) — keyed by prospect_id so each prospect's own lead is a
  // single lookup, never a query.
  const leadByProspect = new Map((leads ?? []).filter((l) => l.prospect_id).map((l) => [l.prospect_id as string, l]));

  function toRow(p: (typeof prospectRows)[number]): ProspectRow {
    const raw = parseProspectRawData(p.raw_data);
    const lead = leadByProspect.get(p.id) ?? null;
    return {
      id: p.id,
      companyName: p.company_name,
      contactName: p.contact_name,
      email: p.email,
      phone: p.phone,
      website: p.website,
      sourceUrl: raw.sourceUrl,
      // No lead yet (should be rare/transient) reads as "new" — genuinely
      // nothing has happened on the lead side, not an invented review state.
      stage: lead ? classifyProspectStage({ qualificationStatus: lead.qualification_status, researchStatus: lead.research_status }) : "new",
      createdAt: p.created_at,
      leadId: lead?.id ?? null,
    };
  }

  const prospectsByCampaign = new Map<string, ProspectRow[]>();
  const unassignedProspects: ProspectRow[] = [];
  for (const p of prospectRows) {
    const row = toRow(p);
    if (!p.campaign_id) {
      unassignedProspects.push(row);
      continue;
    }
    const bucket = prospectsByCampaign.get(p.campaign_id) ?? [];
    bucket.push(row);
    prospectsByCampaign.set(p.campaign_id, bucket);
  }

  const campaignById = new Map(campaignRows.map((c) => [c.id, c]));
  const campaignSummaries = campaignRows.map((c) => {
    const campaignProspects = prospectsByCampaign.get(c.id) ?? [];
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      prospectCount: campaignProspects.length,
      qualifiedCount: campaignProspects.filter((p) => p.stage === "qualified").length,
    };
  });

  const selectedCampaign = selectedCampaignId ? campaignById.get(selectedCampaignId) : undefined;
  const selected =
    selectedCampaignId === UNASSIGNED_ID
      ? { name: "Unassigned Prospects", prospects: unassignedProspects }
      : selectedCampaign
        ? { name: selectedCampaign.name, prospects: prospectsByCampaign.get(selectedCampaign.id) ?? [] }
        : null;

  // No selection, or an id that doesn't belong to this organization — show
  // the campaign picker rather than guessing or leaking another org's data.
  if (!selected) {
    return <ProspectCampaignPickerClient campaigns={campaignSummaries} unassignedCount={unassignedProspects.length} />;
  }

  return <ProspectLifecycleClient campaignName={selected.name} backHref="/prospects" prospects={selected.prospects} />;
}
