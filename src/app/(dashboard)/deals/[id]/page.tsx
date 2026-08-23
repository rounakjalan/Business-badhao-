import { notFound } from "next/navigation";
import { DealDetailTabs } from "@/app/(dashboard)/deals/[id]/deal-detail-tabs";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data: deal } = await supabase
    .from("deals")
    .select("id, title, status, value, currency, probability, expected_close_date, loss_reason, lead_id, campaign_id, created_at")
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!deal) notFound();

  const [identity, campaign, conversation, tasks, events, lossAnalysis] = await Promise.all([
    deal.lead_id
      ? resolveLeadIdentity(supabase, deal.lead_id)
      : Promise.resolve(null),
    deal.campaign_id ? supabase.from("campaigns").select("name").eq("id", deal.campaign_id).maybeSingle() : Promise.resolve({ data: null }),
    deal.lead_id
      ? supabase.from("conversations").select("id, channel, status").eq("lead_id", deal.lead_id).order("created_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("tasks").select("id, title, status, due_at").eq("related_entity_type", "deal").eq("related_entity_id", id).order("created_at", { ascending: false }),
    supabase.from("deal_events").select("id, event_type, created_at").eq("deal_id", id).order("created_at", { ascending: false }),
    supabase.from("loss_analysis").select("id, reason_category, summary, created_at").eq("deal_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  return (
    <DealDetailTabs
      deal={deal}
      customerName={identity?.name ?? "Unassigned"}
      campaignName={campaign.data?.name ?? null}
      conversation={conversation.data}
      tasks={tasks.data ?? []}
      events={events.data ?? []}
      lossAnalysis={lossAnalysis.data}
    />
  );
}
