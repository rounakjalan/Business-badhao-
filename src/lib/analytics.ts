import { createClient } from "@/lib/supabase/server";

/**
 * Per-campaign acquisition performance for the Analytics page — leads,
 * qualified, conversations, deals, won, revenue, and the derived
 * conversion rate. Computed by analytics_campaign_performance (see
 * supabase/migrations/20260910000000_analytics_aggregation_functions.sql),
 * which groups leads/conversations/deals by campaign_id in Postgres,
 * instead of fetching every one of those rows for the organization and
 * grouping them here. Same numbers the page always showed — just computed
 * where the rows already live, so the amount transferred to the app stays
 * O(campaign count), not O(lead+conversation+deal count).
 */
export type CampaignPerformanceRow = {
  name: string;
  leads: number;
  qualified: number;
  conversations: number;
  deals: number;
  won: number;
  revenue: number;
  cr: string;
};

export async function getCampaignPerformance(organizationId: string): Promise<CampaignPerformanceRow[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("analytics_campaign_performance", { p_organization_id: organizationId });

  return (data ?? []).map((row) => {
    const leads = Number(row.leads_count);
    const won = Number(row.won_count);
    return {
      name: row.campaign_name,
      leads,
      qualified: Number(row.qualified_count),
      conversations: Number(row.conversations_count),
      deals: Number(row.deals_count),
      won,
      revenue: Number(row.revenue),
      cr: leads > 0 ? ((won / leads) * 100).toFixed(1) : "0.0",
    };
  });
}

/**
 * Per-lead-source performance for the Analytics page — prospect and lead
 * counts per source. Computed by analytics_lead_source_performance, same
 * reasoning as getCampaignPerformance above.
 */
export type LeadSourcePerformanceRow = {
  source: string;
  prospects: number;
  leads: number;
};

export async function getLeadSourcePerformance(organizationId: string): Promise<LeadSourcePerformanceRow[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("analytics_lead_source_performance", { p_organization_id: organizationId });

  return (data ?? []).map((row) => ({
    source: row.lead_source_name,
    prospects: Number(row.prospects_count),
    leads: Number(row.leads_count),
  }));
}

/**
 * Org-wide won-deal count and revenue for the Analytics page's "Overall
 * Performance" card — every deal in the organization regardless of
 * campaign, matching what the page previously computed from every deal row
 * fetched into JavaScript. Computed by analytics_overall_totals.
 */
export type OverallTotals = {
  totalWon: number;
  totalRevenue: number;
};

export async function getOverallTotals(organizationId: string): Promise<OverallTotals> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("analytics_overall_totals", { p_organization_id: organizationId });
  const row = data?.[0];

  return {
    totalWon: Number(row?.total_won ?? 0),
    totalRevenue: Number(row?.total_revenue ?? 0),
  };
}
