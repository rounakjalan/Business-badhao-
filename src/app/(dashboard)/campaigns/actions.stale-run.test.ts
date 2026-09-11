import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A discovery run's serverless function can die (300s platform timeout,
// deploy, crash) before it ever writes a terminal status to its agent_runs
// row — the duplicate-run guard in startLeadDiscoveryAction already knows
// this and refuses to be blocked by a stale "running" row. But until this
// fix, nothing corrected the row itself: getLeadDiscoveryProgressAction and
// getLeadDiscoveryStateAction both read `status` straight off the row, so
// the Lead Discovery tab kept showing "Discovery running..." / "Last run:
// Running" forever — for up to a full day, since this project's Vercel plan
// only allows its cron sweep to run once every 24 hours, not hourly (see
// vercel.json's own commit history). This proves both read paths now heal a
// stale "running" row to "failed" the first time anything reads it, and
// leave a genuinely fresh "running" row alone.

vi.mock("@/lib/organizations", () => ({ getCurrentOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { getLeadDiscoveryProgressAction, getLeadDiscoveryStateAction } from "@/app/(dashboard)/campaigns/actions";

const ORG = { organizationId: "org-1", organizationName: "Acme", role: "owner" as const };

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

// Same shape of in-memory Supabase stand-in as
// actions.discovery-research.test.ts, extended with `contains` — the one
// query builder method the read paths under test use that file's fake
// didn't need.
function createFakeSupabase(tables: Tables) {
  function builder(table: string) {
    tables[table] = tables[table] ?? [];
    const filters: ((row: Row) => boolean)[] = [];
    let orderSpec: { column: string; ascending: boolean } | null = null;
    let limitN: number | null = null;
    let pendingUpdate: Row | null = null;

    function execute(): Row[] {
      if (pendingUpdate) {
        const update = pendingUpdate;
        const matched = tables[table].filter((row) => filters.every((f) => f(row)));
        tables[table] = tables[table].map((row) => (filters.every((f) => f(row)) ? { ...row, ...update } : row));
        return matched.map((row) => ({ ...row, ...update }));
      }
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
      update(payload: Row) {
        pendingUpdate = payload;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return api;
      },
      contains(column: string, value: Record<string, unknown>) {
        filters.push((row) => {
          const cell = row[column] as Record<string, unknown> | null | undefined;
          return Boolean(cell) && Object.entries(value).every(([k, v]) => cell?.[k] === v);
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

  return { from: (table: string) => builder(table) };
}

function seedRunningRun(startedAt: string): Tables {
  return {
    agent_runs: [
      {
        id: "run-1",
        organization_id: "org-1",
        agent_type: "lead_discovery",
        status: "running",
        input: { campaignId: "campaign-1" },
        started_at: startedAt,
        completed_at: null,
        output: {},
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getLeadDiscoveryProgressAction — stale run healing", () => {
  it("reports a genuinely fresh running run as running, untouched", async () => {
    const startedTwoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const tables = seedRunningRun(startedTwoMinutesAgo);
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables) as never);

    const result = await getLeadDiscoveryProgressAction("campaign-1");

    expect(result.status).toBe("running");
    expect(tables.agent_runs[0].status).toBe("running");
  });

  it("heals a running run older than the stale window to failed, and writes the correction back", async () => {
    const startedTwentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const tables = seedRunningRun(startedTwentyMinutesAgo);
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables) as never);

    const result = await getLeadDiscoveryProgressAction("campaign-1");

    expect(result.status).toBe("failed");
    // Not just corrected in the response — the row itself is fixed, so the
    // duplicate-run guard and every other future reader see the truth too.
    expect(tables.agent_runs[0].status).toBe("failed");
    expect(tables.agent_runs[0].completed_at).not.toBeNull();
  });
});

describe("getLeadDiscoveryStateAction — stale run healing", () => {
  it("reports a genuinely fresh running run as running, untouched", async () => {
    const startedTwoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const tables = seedRunningRun(startedTwoMinutesAgo);
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables) as never);

    const result = await getLeadDiscoveryStateAction("campaign-1");

    expect(result.lastRun?.status).toBe("running");
    expect(tables.agent_runs[0].status).toBe("running");
  });

  it("heals a running run older than the stale window to failed", async () => {
    const startedTwentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const tables = seedRunningRun(startedTwentyMinutesAgo);
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables) as never);

    const result = await getLeadDiscoveryStateAction("campaign-1");

    expect(result.lastRun?.status).toBe("failed");
    expect(tables.agent_runs[0].status).toBe("failed");
  });
});
