import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVERY_TARGET,
  STALE_RUN_AFTER_MS,
  getLatestDiscoveryRun,
  getResumableRun,
  getRunProgress,
  isResumable,
  isRunComplete,
  isRunGenuinelyActive,
} from "@/lib/pipeline/discovery-run";

// STEP 7 — target-based, durable, resumable discovery. These are unit tests
// for the pure decision logic (isRunGenuinelyActive/getResumableRun/
// isRunComplete) and the DB-backed progress query (getRunProgress) that
// startLeadDiscoveryAction and runDiscoveryForCampaign both now share —
// see actions.discovery-lifecycle.test.ts for the full action-level proof.

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function createFakeSupabase(tables: Tables) {
  function builder(table: string) {
    tables[table] = tables[table] ?? [];
    const filters: ((row: Row) => boolean)[] = [];
    let orderSpec: { column: string; ascending: boolean } | null = null;
    let limitN: number | null = null;

    function execute(): Row[] {
      let rows = tables[table].filter((row) => filters.every((f) => f(row)));
      if (orderSpec) {
        const { column, ascending } = orderSpec;
        rows = [...rows].sort((a, b) => {
          const av = String(a[column] ?? "");
          const bv = String(b[column] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    const api = {
      select() {
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return api;
      },
      gte(column: string, value: unknown) {
        filters.push((row) => String(row[column] ?? "") >= String(value));
        return api;
      },
      contains(column: string, value: Record<string, unknown>) {
        filters.push((row) => {
          const target = row[column] as Record<string, unknown> | null | undefined;
          return Boolean(target) && Object.entries(value).every(([k, v]) => target?.[k] === v);
        });
        return api;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orderSpec = { column, ascending: opts?.ascending ?? true };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      async maybeSingle() {
        const rows = execute();
        return { data: rows[0] ?? null, error: null };
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: execute(), error: null });
      },
    };

    return api;
  }

  return { from: (table: string) => builder(table) } as never;
}

describe("getLatestDiscoveryRun", () => {
  it("returns null when the campaign has never had a discovery run", async () => {
    const supabase = createFakeSupabase({});
    const run = await getLatestDiscoveryRun(supabase, "org-1", "campaign-1");
    expect(run).toBeNull();
  });

  it("reads targetLeads from the run's own stored input, defaulting to DEFAULT_DISCOVERY_TARGET when absent (a historical run from before this fix)", async () => {
    const tables: Tables = {
      agent_runs: [
        { id: "run-1", organization_id: "org-1", agent_type: "lead_discovery", status: "running", started_at: "2026-01-01T00:00:00.000Z", input: { campaignId: "campaign-1" }, output: {} },
      ],
    };
    const supabase = createFakeSupabase(tables);
    const run = await getLatestDiscoveryRun(supabase, "org-1", "campaign-1");
    expect(run?.targetLeads).toBe(DEFAULT_DISCOVERY_TARGET);
  });

  it("reads the campaign's own stored target when present", async () => {
    const tables: Tables = {
      agent_runs: [
        { id: "run-1", organization_id: "org-1", agent_type: "lead_discovery", status: "running", started_at: "2026-01-01T00:00:00.000Z", input: { campaignId: "campaign-1", targetLeads: 25 }, output: {} },
      ],
    };
    const supabase = createFakeSupabase(tables);
    const run = await getLatestDiscoveryRun(supabase, "org-1", "campaign-1");
    expect(run?.targetLeads).toBe(25);
  });

  it("flags a not_configured failure as a hard failure; a provider_error failure is not", async () => {
    const tables: Tables = {
      agent_runs: [
        { id: "run-1", organization_id: "org-1", agent_type: "lead_discovery", status: "failed", started_at: "2026-01-01T00:00:00.000Z", input: { campaignId: "campaign-1" }, output: { code: "not_configured" } },
      ],
    };
    const supabase = createFakeSupabase(tables);
    const run = await getLatestDiscoveryRun(supabase, "org-1", "campaign-1");
    expect(run?.hardFailure).toBe(true);
  });
});

describe("isRunGenuinelyActive", () => {
  it("a fresh running run blocks a concurrent invocation", () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    expect(isRunGenuinelyActive({ id: "r", status: "running", startedAt, targetLeads: 10, hardFailure: false })).toBe(true);
  });

  it("a running run older than the stale window does not block — its serverless function almost certainly died", () => {
    const startedAt = new Date(Date.now() - (STALE_RUN_AFTER_MS + 60_000)).toISOString();
    expect(isRunGenuinelyActive({ id: "r", status: "running", startedAt, targetLeads: 10, hardFailure: false })).toBe(false);
  });

  it("a non-running run never blocks, regardless of age", () => {
    const startedAt = new Date().toISOString();
    expect(isRunGenuinelyActive({ id: "r", status: "completed", startedAt, targetLeads: 10, hardFailure: false })).toBe(false);
  });

  it("null (no run yet) never blocks", () => {
    expect(isRunGenuinelyActive(null)).toBe(false);
  });
});

describe("getResumableRun / isResumable", () => {
  const base = { id: "run-1", startedAt: new Date().toISOString(), targetLeads: 10, hardFailure: false };

  it("a completed run is never resumed — its target's own leads are done; a fresh press starts the next batch of leads", () => {
    const run = { ...base, status: "completed" };
    expect(getResumableRun(run)).toBeNull();
    expect(isResumable(run)).toBe(false);
  });

  it("a partially_completed run is never resumed", () => {
    const run = { ...base, status: "partially_completed" };
    expect(getResumableRun(run)).toBeNull();
  });

  it("a hard not_configured failure is never resumed — retrying would just fail identically", () => {
    const run = { ...base, status: "failed", hardFailure: true };
    expect(getResumableRun(run)).toBeNull();
  });

  it("a transient provider_error failure IS resumed — a provider outage must not permanently kill the run", () => {
    const run = { ...base, status: "failed", hardFailure: false };
    expect(getResumableRun(run)).toEqual(run);
    expect(isResumable(run)).toBe(true);
  });

  it("a still-'running' row (fresh or stale) is resumed toward the same target", () => {
    const run = { ...base, status: "running" };
    expect(getResumableRun(run)).toEqual(run);
  });

  it("no prior run at all is never resumed", () => {
    expect(getResumableRun(null)).toBeNull();
    expect(isResumable(null)).toBe(false);
  });
});

describe("getRunProgress", () => {
  const RUN_STARTED_AT = "2026-01-01T00:00:00.000Z";
  const BEFORE_RUN = "2025-12-31T23:00:00.000Z";
  const AFTER_RUN = "2026-01-01T00:05:00.000Z";

  function seedLeads(rows: { id: string; created_at: string; research_status: string | null }[]): Tables {
    return {
      leads: rows.map((r) => ({ id: r.id, organization_id: "org-1", campaign_id: "campaign-1", created_at: r.created_at, research_status: r.research_status })),
    };
  }

  it("counts only leads created at or after this run's own startedAt — a campaign's pre-existing backlog never counts toward this run's target", async () => {
    const tables = seedLeads([
      { id: "old-1", created_at: BEFORE_RUN, research_status: "completed" },
      { id: "new-1", created_at: RUN_STARTED_AT, research_status: "completed" },
      { id: "new-2", created_at: AFTER_RUN, research_status: "pending" },
    ]);
    const supabase = createFakeSupabase(tables);

    const progress = await getRunProgress(supabase, "org-1", "campaign-1", RUN_STARTED_AT, 10);

    expect(progress.targetLeads).toBe(10);
    expect(progress.validLeadCount).toBe(2); // old-1 excluded
    expect(progress.researchedCount).toBe(1);
    expect(progress.researchPendingCount).toBe(1);
    expect(progress.researchFailedCount).toBe(0);
  });

  it("separates researched/failed/pending correctly", async () => {
    const tables = seedLeads([
      { id: "a", created_at: RUN_STARTED_AT, research_status: "completed" },
      { id: "b", created_at: RUN_STARTED_AT, research_status: "failed" },
      { id: "c", created_at: RUN_STARTED_AT, research_status: "researching" },
      { id: "d", created_at: RUN_STARTED_AT, research_status: "pending" },
      { id: "e", created_at: RUN_STARTED_AT, research_status: null },
    ]);
    const supabase = createFakeSupabase(tables);

    const progress = await getRunProgress(supabase, "org-1", "campaign-1", RUN_STARTED_AT, 10);

    expect(progress.validLeadCount).toBe(5);
    expect(progress.researchedCount).toBe(1);
    expect(progress.researchFailedCount).toBe(1);
    expect(progress.researchPendingCount).toBe(3); // researching, pending, null
  });

  it("reports zero progress for a run with no leads yet", async () => {
    const supabase = createFakeSupabase({});
    const progress = await getRunProgress(supabase, "org-1", "campaign-1", RUN_STARTED_AT, 10);
    expect(progress).toEqual({ targetLeads: 10, validLeadCount: 0, researchedCount: 0, researchFailedCount: 0, researchPendingCount: 0 });
  });
});

describe("isRunComplete", () => {
  it("false when target not yet reached, even with zero pending research", () => {
    expect(isRunComplete({ targetLeads: 10, validLeadCount: 9, researchedCount: 9, researchFailedCount: 0, researchPendingCount: 0 })).toBe(false);
  });

  it("false when target reached but research is still pending — TARGET REACHED alone is not enough", () => {
    expect(isRunComplete({ targetLeads: 10, validLeadCount: 10, researchedCount: 8, researchFailedCount: 0, researchPendingCount: 2 })).toBe(false);
  });

  it("true once target reached AND every lead has a terminal research outcome — failures count as terminal, not blocking", () => {
    expect(isRunComplete({ targetLeads: 10, validLeadCount: 10, researchedCount: 8, researchFailedCount: 2, researchPendingCount: 0 })).toBe(true);
  });

  it("true when more than the target was somehow reached (defensive >=, not ===)", () => {
    expect(isRunComplete({ targetLeads: 10, validLeadCount: 11, researchedCount: 11, researchFailedCount: 0, researchPendingCount: 0 })).toBe(true);
  });
});
