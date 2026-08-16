import { notFound } from "next/navigation";
import { CampaignDetailTabs } from "@/app/(dashboard)/campaigns/[id]/campaign-detail-tabs";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, name, objective, description, target_audience, status, created_at")
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!campaign) notFound();

  const [leads, conversations, deals] = await Promise.all([
    supabase.from("leads").select("id, qualification_status").eq("campaign_id", id),
    supabase
      .from("conversations")
      .select("id, channel, status, intent, created_at")
      .eq("campaign_id", id)
      .order("created_at", { ascending: false }),
    supabase.from("deals").select("id, title, status, value, currency, created_at").eq("campaign_id", id).order("created_at", { ascending: false }),
  ]);

  const leadCount = leads.data?.length ?? 0;
  const qualifiedCount = leads.data?.filter((l) => l.qualification_status === "qualified").length ?? 0;
  const revenue = (deals.data ?? []).filter((d) => d.status === "won").reduce((sum, d) => sum + Number(d.value), 0);

  return (
    <CampaignDetailTabs
      campaign={campaign}
      leadCount={leadCount}
      qualifiedCount={qualifiedCount}
      conversations={conversations.data ?? []}
      deals={deals.data ?? []}
      revenue={revenue}
    />
  );
}
