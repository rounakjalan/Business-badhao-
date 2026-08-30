import { notFound } from "next/navigation";
import { CampaignDetailTabs } from "@/app/(dashboard)/campaigns/[id]/campaign-detail-tabs";
import { getLeadDiscoveryStateAction } from "@/app/(dashboard)/campaigns/actions";
import { getDiscoveryProvider } from "@/lib/ai/agents/discovery";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, name, objective, description, target_audience, status, created_at, ideal_customer_profile_id")
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!campaign) notFound();

  const icp = campaign.ideal_customer_profile_id
    ? (await supabase.from("ideal_customer_profiles").select("criteria").eq("id", campaign.ideal_customer_profile_id).maybeSingle()).data
        ?.criteria ?? null
    : null;

  const [leads, conversations, deals, discovery] = await Promise.all([
    supabase.from("leads").select("id, qualification_status").eq("campaign_id", id),
    supabase
      .from("conversations")
      .select("id, channel, status, intent, created_at")
      .eq("campaign_id", id)
      .order("created_at", { ascending: false }),
    supabase.from("deals").select("id, title, status, value, currency, created_at").eq("campaign_id", id).order("created_at", { ascending: false }),
    getLeadDiscoveryStateAction(id),
  ]);

  const leadRows = leads.data ?? [];
  const leadCount = leadRows.length;

  // Counted per status rather than as a single "qualified" number. Leads
  // legitimately rest at "qualifying" — the pipeline withholds a final
  // verdict without strong evidence — so a lone qualified count reads 0 on
  // a run where research and scoring both worked, which looks like failure.
  const leadStatusCounts = {
    pending: leadRows.filter((l) => l.qualification_status === "pending").length,
    qualifying: leadRows.filter((l) => l.qualification_status === "qualifying").length,
    qualified: leadRows.filter((l) => l.qualification_status === "qualified").length,
    disqualified: leadRows.filter((l) => l.qualification_status === "disqualified").length,
  };
  const scoredCount = leadCount - leadStatusCounts.pending;
  const revenue = (deals.data ?? []).filter((d) => d.status === "won").reduce((sum, d) => sum + Number(d.value), 0);

  return (
    <CampaignDetailTabs
      campaign={campaign}
      icp={icp}
      leadCount={leadCount}
      scoredCount={scoredCount}
      leadStatusCounts={leadStatusCounts}
      conversations={conversations.data ?? []}
      deals={deals.data ?? []}
      revenue={revenue}
      discovery={discovery}
      discoveryConfigured={getDiscoveryProvider().isConfigured()}
    />
  );
}
