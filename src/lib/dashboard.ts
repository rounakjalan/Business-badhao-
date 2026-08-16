import { createClient } from "@/lib/supabase/server";

export type DashboardStats = {
  totalLeads: number;
  qualifiedLeads: number;
  activeConversations: number;
  openDeals: number;
  wonDeals: number;
  openPipelineValue: number;
  currency: string;
};

/**
 * Aggregate counts are computed as separate `head: true` count queries
 * rather than fetching rows, and the pipeline value is summed client-side
 * over a single small result set. This assumes one currency per
 * organization for now — multi-currency roll-up is out of scope for this
 * phase.
 */
export async function getDashboardStats(organizationId: string): Promise<DashboardStats> {
  const supabase = await createClient();

  const [totalLeads, qualifiedLeads, activeConversations, openDeals, wonDeals, openDealRows] = await Promise.all([
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("qualification_status", "qualified"),
    supabase
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "open"),
    supabase.from("deals").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "open"),
    supabase.from("deals").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "won"),
    supabase.from("deals").select("value, currency").eq("organization_id", organizationId).eq("status", "open"),
  ]);

  const firstError = [totalLeads, qualifiedLeads, activeConversations, openDeals, wonDeals, openDealRows].find(
    (result) => result.error
  )?.error;
  if (firstError) {
    throw new Error(firstError.message);
  }

  const openPipelineValue = (openDealRows.data ?? []).reduce((sum, row) => sum + Number(row.value), 0);

  return {
    totalLeads: totalLeads.count ?? 0,
    qualifiedLeads: qualifiedLeads.count ?? 0,
    activeConversations: activeConversations.count ?? 0,
    openDeals: openDeals.count ?? 0,
    wonDeals: wonDeals.count ?? 0,
    openPipelineValue,
    currency: openDealRows.data?.[0]?.currency ?? "INR",
  };
}
