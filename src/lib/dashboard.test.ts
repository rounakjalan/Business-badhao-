import { describe, expect, it, vi } from "vitest";

// Metrics audit: dashboard.ts had zero test coverage despite backing every
// number on the Command Center page. These tests prove every stat is a real,
// org-scoped count/sum — never a hardcoded or fabricated value — and that
// percentages/funnel stages behave correctly for both an empty and a
// populated organization, including the join-fan-out bug the acquisition
// funnel's own code comment describes ("counting rows for these stages
// compares threads and quotes against people, which is what made the funnel
// report conversion rates above 100%").

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/lead-names", () => ({ resolveLeadIdentities: vi.fn(async () => new Map()) }));

import { createClient } from "@/lib/supabase/server";
import { getAcquisitionFunnel, getDashboardStats } from "@/lib/dashboard";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

/** A minimal thenable query-builder stand-in, same convention used across
 * this codebase's other test files: every chain method returns the builder,
 * filters accumulate and are only actually applied when awaited, and a
 * `head: true` select resolves as a count rather than rows — matching how
 * the real Supabase client behaves. */
function makeBuilder(rows: Row[], filters: Filter[] = [], opts: { head?: boolean } = {}): PromiseLike<{ data: Row[] | null; count: number | null; error: null }> & Record<string, unknown> {
  const builder = {
    select: (_cols: string, o?: { head?: boolean }) => makeBuilder(rows, filters, o ?? {}),
    eq: (col: string, val: unknown) => makeBuilder(rows, [...filters, (r) => r[col] === val], opts),
    in: (col: string, vals: unknown[]) => makeBuilder(rows, [...filters, (r) => vals.includes(r[col])], opts),
    not: (col: string, op: string, val: unknown) => makeBuilder(rows, [...filters, (r) => (op === "eq" ? r[col] !== val : true)], opts),
    gte: (col: string, val: string) => makeBuilder(rows, [...filters, (r) => String(r[col]) >= val], opts),
    lte: (col: string, val: string) => makeBuilder(rows, [...filters, (r) => String(r[col]) <= val], opts),
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => builder,
    then: (resolve: (v: { data: Row[] | null; count: number | null; error: null }) => void) => {
      const filtered = rows.filter((r) => filters.every((f) => f(r)));
      resolve(opts.head ? { data: null, count: filtered.length, error: null } : { data: filtered, count: null, error: null });
    },
  };
  return builder as never;
}

function fakeSupabase(tables: Record<string, Row[]>) {
  return { from: (table: string) => makeBuilder(tables[table] ?? []) } as never;
}

const ORG = "org-1";

describe("getDashboardStats", () => {
  it("returns every stat as zero for an organization with no records — never a fabricated number", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase({}));

    const stats = await getDashboardStats(ORG);

    expect(stats).toEqual({
      totalProspects: 0,
      totalLeads: 0,
      qualifiedLeads: 0,
      activeConversations: 0,
      followUpsDue: 0,
      openDeals: 0,
      openPipelineValue: 0,
      wonThisMonth: 0,
      wonRevenueThisMonth: 0,
      lostThisMonth: 0,
      conversionRate: 0,
      currency: "INR",
    });
  });

  it("computes every count and sum from real rows scoped to the given organization", async () => {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 5).toISOString();
    const pastDue = new Date(now.getTime() - 60_000).toISOString();
    const future = new Date(now.getTime() + 60_000).toISOString();

    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        prospects: [
          { organization_id: ORG, id: "p1" },
          { organization_id: ORG, id: "p2" },
          { organization_id: "org-2", id: "p3" }, // a different organization's row — must never be counted
        ],
        leads: [
          { organization_id: ORG, id: "l1", qualification_status: "qualified" },
          { organization_id: ORG, id: "l2", qualification_status: "qualified" },
          { organization_id: ORG, id: "l3", qualification_status: "pending" },
          { organization_id: "org-2", id: "l4", qualification_status: "qualified" }, // other org
        ],
        conversations: [
          { organization_id: ORG, id: "c1", status: "open" },
          { organization_id: ORG, id: "c2", status: "closed" }, // not open — excluded
        ],
        tasks: [
          { organization_id: ORG, id: "t1", status: "pending", due_at: pastDue },
          { organization_id: ORG, id: "t2", status: "in_progress", due_at: pastDue },
          { organization_id: ORG, id: "t3", status: "pending", due_at: future }, // not yet due — excluded
          { organization_id: ORG, id: "t4", status: "completed", due_at: pastDue }, // already done — excluded
        ],
        deals: [
          { organization_id: ORG, id: "d1", status: "new", value: "500", currency: "USD" },
          { organization_id: ORG, id: "d2", status: "proposal", value: "1500", currency: "USD" },
          { organization_id: ORG, id: "d3", status: "won", value: "2000", currency: "USD", won_at: startOfThisMonth },
          { organization_id: ORG, id: "d4", status: "won", value: "9999", currency: "USD", won_at: "2020-01-01T00:00:00.000Z" }, // won, but not this month
          { organization_id: ORG, id: "d5", status: "lost", value: "300", currency: "USD", lost_at: startOfThisMonth },
        ],
      })
    );

    const stats = await getDashboardStats(ORG);

    expect(stats.totalProspects).toBe(2);
    expect(stats.totalLeads).toBe(3);
    expect(stats.qualifiedLeads).toBe(2);
    expect(stats.activeConversations).toBe(1);
    expect(stats.followUpsDue).toBe(2);
    expect(stats.openDeals).toBe(2);
    expect(stats.openPipelineValue).toBe(2000); // 500 + 1500, only the two open-stage deals
    expect(stats.wonThisMonth).toBe(1);
    expect(stats.wonRevenueThisMonth).toBe(2000);
    expect(stats.lostThisMonth).toBe(1);
    // 2 total won deals (d3 + d4, regardless of month) / 3 total leads * 100
    expect(stats.conversionRate).toBeCloseTo((2 / 3) * 100, 5);
    expect(stats.currency).toBe("USD");
  });

  it("reports a 0% conversion rate when the organization has no leads yet, rather than dividing by zero", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        deals: [{ organization_id: ORG, id: "d1", status: "won", value: "500", currency: "INR", won_at: new Date().toISOString() }],
      })
    );

    const stats = await getDashboardStats(ORG);
    expect(stats.conversionRate).toBe(0);
  });

  it("falls back to the won-this-month deal's currency when there are no open deals, and to INR when there are none at all", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        deals: [{ organization_id: ORG, id: "d1", status: "won", value: "500", currency: "EUR", won_at: new Date().toISOString() }],
      })
    );
    expect((await getDashboardStats(ORG)).currency).toBe("EUR");

    vi.mocked(createClient).mockResolvedValue(fakeSupabase({}));
    expect((await getDashboardStats(ORG)).currency).toBe("INR");
  });
});

describe("getAcquisitionFunnel", () => {
  it("returns every stage as zero for an organization with no records", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase({}));

    const funnel = await getAcquisitionFunnel(ORG);

    expect(funnel).toEqual([
      { stage: "Prospects", count: 0 },
      { stage: "Leads", count: 0 },
      { stage: "Contacted", count: 0 },
      { stage: "Qualified", count: 0 },
      { stage: "Conversations", count: 0 },
      { stage: "Deals", count: 0 },
      { stage: "Won", count: 0 },
    ]);
  });

  it("counts distinct leads per stage, never raw conversation/deal rows — one lead with 3 conversations and 2 deals is still 1 in each stage", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        prospects: [{ organization_id: ORG, id: "p1" }, { organization_id: ORG, id: "p2" }],
        leads: [
          { organization_id: ORG, id: "l1", status: "new" },
          { organization_id: ORG, id: "l2", status: "contacted", qualification_status: "qualified" },
        ],
        conversations: [
          { organization_id: ORG, lead_id: "l2" },
          { organization_id: ORG, lead_id: "l2" },
          { organization_id: ORG, lead_id: "l2" },
        ],
        deals: [
          { organization_id: ORG, lead_id: "l2", status: "new" },
          { organization_id: ORG, lead_id: "l2", status: "won" },
        ],
      })
    );

    const funnel = await getAcquisitionFunnel(ORG);
    const byStage = Object.fromEntries(funnel.map((f) => [f.stage, f.count]));

    expect(byStage["Conversations"]).toBe(1); // one lead, not three conversation rows
    expect(byStage["Deals"]).toBe(1); // one lead, not two deal rows
    expect(byStage["Won"]).toBe(1); // that lead has at least one won deal
  });

  it("excludes leads with no won deal from the Won stage even if they have other deals", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        leads: [{ organization_id: ORG, id: "l1", status: "new" }],
        deals: [{ organization_id: ORG, lead_id: "l1", status: "proposal" }],
      })
    );

    const funnel = await getAcquisitionFunnel(ORG);
    expect(funnel.find((f) => f.stage === "Won")?.count).toBe(0);
    expect(funnel.find((f) => f.stage === "Deals")?.count).toBe(1);
  });
});
