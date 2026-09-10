import { afterEach, describe, expect, it, vi } from "vitest";

// analytics_campaign_performance/analytics_lead_source_performance/
// analytics_overall_totals (supabase/migrations/20260910000000_analytics_
// aggregation_functions.sql) do the actual grouping/filtering in Postgres —
// these tests prove this thin TypeScript layer calls them with the right
// organization, and reshapes their rows into exactly the numbers the
// Analytics page used to compute itself from raw leads/conversations/deals/
// prospects rows. The SQL aggregation itself (status filtering, org
// isolation, empty-org behaviour, and equivalence with the old per-row
// JavaScript grouping) was verified directly against real production data
// — see the fix's own report for the exact comparison queries and results.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { getCampaignPerformance, getLeadSourcePerformance, getOverallTotals } from "@/lib/analytics";

type RpcCall = { name: string; args: unknown };

function fakeSupabase(responses: Record<string, { data: unknown; error: unknown }>) {
  const calls: RpcCall[] = [];
  return {
    calls,
    client: {
      rpc: vi.fn(async (name: string, args: unknown) => {
        calls.push({ name, args });
        return responses[name] ?? { data: null, error: null };
      }),
    },
  };
}

describe("getCampaignPerformance", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls analytics_campaign_performance scoped to exactly the given organization — never a different one", async () => {
    const { client, calls } = fakeSupabase({ analytics_campaign_performance: { data: [], error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    await getCampaignPerformance("org-1");

    expect(calls).toEqual([{ name: "analytics_campaign_performance", args: { p_organization_id: "org-1" } }]);
  });

  it("reproduces the exact numbers the page used to compute itself from raw rows — counts, won revenue, and the derived conversion rate", async () => {
    const { client } = fakeSupabase({
      analytics_campaign_performance: {
        data: [
          {
            campaign_id: "c1",
            campaign_name: "Web designing agency",
            leads_count: 18,
            qualified_count: 0,
            conversations_count: 1,
            deals_count: 2,
            won_count: 1,
            revenue: "25000",
          },
        ],
        error: null,
      },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const result = await getCampaignPerformance("org-1");

    // 1 won / 18 leads = 5.555...% — (1/18*100).toFixed(1), the exact
    // expression the page always used, reproduced here against a value
    // that came back from Postgres as a numeric (a string over the wire).
    expect(result).toEqual([
      { name: "Web designing agency", leads: 18, qualified: 0, conversations: 1, deals: 2, won: 1, revenue: 25000, cr: "5.6" },
    ]);
  });

  it("reports a 0.0% conversion rate for a campaign with zero leads rather than dividing by zero", async () => {
    const { client } = fakeSupabase({
      analytics_campaign_performance: {
        data: [{ campaign_id: "c1", campaign_name: "Brand new campaign", leads_count: 0, qualified_count: 0, conversations_count: 0, deals_count: 0, won_count: 0, revenue: "0" }],
        error: null,
      },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const result = await getCampaignPerformance("org-1");
    expect(result[0].cr).toBe("0.0");
  });

  it("returns an empty list for an organization with no campaigns, rather than throwing — matches the previous behaviour of an empty campaigns query", async () => {
    const { client } = fakeSupabase({ analytics_campaign_performance: { data: [], error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    expect(await getCampaignPerformance("org-empty")).toEqual([]);
  });

  it("treats a null/errored RPC response the same way the old per-row queries treated an error — an empty list, never a thrown error that would take down the whole page", async () => {
    const { client } = fakeSupabase({ analytics_campaign_performance: { data: null, error: { message: "boom" } } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    expect(await getCampaignPerformance("org-1")).toEqual([]);
  });
});

describe("getLeadSourcePerformance", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls analytics_lead_source_performance scoped to exactly the given organization", async () => {
    const { client, calls } = fakeSupabase({ analytics_lead_source_performance: { data: [], error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    await getLeadSourcePerformance("org-2");

    expect(calls).toEqual([{ name: "analytics_lead_source_performance", args: { p_organization_id: "org-2" } }]);
  });

  it("reproduces the exact prospect/lead counts the page used to compute from raw prospects/leads rows", async () => {
    const { client } = fakeSupabase({
      analytics_lead_source_performance: {
        data: [{ lead_source_id: "s1", lead_source_name: "AI Lead Discovery", prospects_count: 94, leads_count: 94 }],
        error: null,
      },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    expect(await getLeadSourcePerformance("org-1")).toEqual([{ source: "AI Lead Discovery", prospects: 94, leads: 94 }]);
  });

  it("returns an empty list for an organization with no lead sources", async () => {
    const { client } = fakeSupabase({ analytics_lead_source_performance: { data: [], error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    expect(await getLeadSourcePerformance("org-empty")).toEqual([]);
  });
});

describe("getOverallTotals", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls analytics_overall_totals scoped to exactly the given organization", async () => {
    const { client, calls } = fakeSupabase({ analytics_overall_totals: { data: [{ total_won: 0, total_revenue: "0" }], error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    await getOverallTotals("org-3");

    expect(calls).toEqual([{ name: "analytics_overall_totals", args: { p_organization_id: "org-3" } }]);
  });

  it("reproduces the exact org-wide won count and revenue the page used to compute from every deal row", async () => {
    const { client } = fakeSupabase({ analytics_overall_totals: { data: [{ total_won: 7, total_revenue: "412500" }], error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    expect(await getOverallTotals("org-1")).toEqual({ totalWon: 7, totalRevenue: 412500 });
  });

  it("defaults to zero won/zero revenue for an organization with no deals at all — the RPC still returns one row (an aggregate over zero rows), never no rows", async () => {
    const { client } = fakeSupabase({ analytics_overall_totals: { data: [{ total_won: 0, total_revenue: "0" }], error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    expect(await getOverallTotals("org-empty")).toEqual({ totalWon: 0, totalRevenue: 0 });
  });

  it("defaults to zero won/zero revenue even if the RPC unexpectedly returned no row at all, rather than throwing", async () => {
    const { client } = fakeSupabase({ analytics_overall_totals: { data: [], error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    expect(await getOverallTotals("org-1")).toEqual({ totalWon: 0, totalRevenue: 0 });
  });
});
