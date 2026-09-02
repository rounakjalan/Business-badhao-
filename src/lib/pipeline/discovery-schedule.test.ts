import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DISCOVERY_INTERVAL_MS,
  isDiscoveryDue,
  markDiscoveryFinished,
  minutesUntilNextRun,
  nextDiscoveryRunAt,
  resumeCampaignDiscovery,
  stopCampaignDiscovery,
} from "@/lib/pipeline/discovery-schedule";

const NOW = new Date("2026-09-02T12:00:00.000Z");

describe("nextDiscoveryRunAt", () => {
  it("books the next run one interval out", () => {
    expect(nextDiscoveryRunAt(NOW)).toBe(new Date(NOW.getTime() + DISCOVERY_INTERVAL_MS).toISOString());
  });

  it("uses an hourly interval", () => {
    expect(DISCOVERY_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});

describe("isDiscoveryDue", () => {
  it("is due once the booked time has passed — this is the hourly cycle continuing", () => {
    const row = { discovery_state: "scheduled" as const, discovery_next_run_at: "2026-09-02T11:00:00.000Z" };
    expect(isDiscoveryDue(row, NOW)).toBe(true);
  });

  it("is not due before the booked time, so an hourly sweep does not re-run a campaign every tick", () => {
    const row = { discovery_state: "scheduled" as const, discovery_next_run_at: "2026-09-02T12:30:00.000Z" };
    expect(isDiscoveryDue(row, NOW)).toBe(false);
  });

  it("is due exactly at the booked time", () => {
    const row = { discovery_state: "scheduled" as const, discovery_next_run_at: NOW.toISOString() };
    expect(isDiscoveryDue(row, NOW)).toBe(true);
  });

  it("never runs a stopped campaign, even when its slot is long overdue — Stop must prevent future runs", () => {
    const row = { discovery_state: "stopped" as const, discovery_next_run_at: "2020-01-01T00:00:00.000Z" };
    expect(isDiscoveryDue(row, NOW)).toBe(false);
  });

  it("treats a campaign that has never been scheduled as due, so campaigns predating scheduling keep being swept", () => {
    const row = { discovery_state: "scheduled" as const, discovery_next_run_at: null };
    expect(isDiscoveryDue(row, NOW)).toBe(true);
  });

  it("skips a campaign whose run is genuinely in flight", () => {
    const row = {
      discovery_state: "running" as const,
      discovery_next_run_at: null,
      discovery_last_run_at: new Date(NOW.getTime() - 60_000).toISOString(),
    };
    expect(isDiscoveryDue(row, NOW)).toBe(false);
  });

  it("releases a run stuck at 'running' past the stale window, so a crash cannot end the cycle forever", () => {
    const row = {
      discovery_state: "running" as const,
      discovery_next_run_at: null,
      discovery_last_run_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    };
    expect(isDiscoveryDue(row, NOW)).toBe(true);
  });

  it("retries a failed run once its next slot comes due rather than abandoning the campaign", () => {
    const row = { discovery_state: "failed" as const, discovery_next_run_at: "2026-09-02T11:59:00.000Z" };
    expect(isDiscoveryDue(row, NOW)).toBe(true);
  });

  it("treats an unparsable timestamp as due rather than stranding the campaign", () => {
    const row = { discovery_state: "scheduled" as const, discovery_next_run_at: "not-a-date" };
    expect(isDiscoveryDue(row, NOW)).toBe(true);
  });
});

describe("minutesUntilNextRun", () => {
  it("reports whole minutes until the next run", () => {
    expect(minutesUntilNextRun("2026-09-02T13:00:00.000Z", NOW)).toBe(60);
  });

  it("clamps an overdue run to 0 rather than reporting negative time", () => {
    expect(minutesUntilNextRun("2026-09-02T11:00:00.000Z", NOW)).toBe(0);
  });

  it("returns null when nothing is scheduled", () => {
    expect(minutesUntilNextRun(null, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The DB helpers, against a stub that records exactly what was written. What
// matters here is the *number* of schedule writes as much as their content:
// duplicate scheduling is the failure mode these guard against.
// ---------------------------------------------------------------------------

type Update = { table: string; values: Record<string, unknown> };

function stubClient(existingState: string | null = "running") {
  const updates: Update[] = [];

  const client = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          updates.push({ table, values });
          const chain = {
            eq: () => chain,
            select: () => ({ maybeSingle: async () => ({ data: { id: "campaign-1" }, error: null }) }),
          };
          return chain;
        },
        select() {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({ data: existingState ? { discovery_state: existingState } : null, error: null }),
          };
          return chain;
        },
      };
    },
  };

  // The stub deliberately implements only what these helpers touch.
  return { client: client as never, updates };
}

describe("markDiscoveryFinished", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("books exactly one next run after a successful run", async () => {
    const { client, updates } = stubClient("running");
    await markDiscoveryFinished(client, "campaign-1", "org-1", { ok: true });

    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({
      discovery_state: "scheduled",
      discovery_next_run_at: nextDiscoveryRunAt(NOW),
      discovery_last_error: null,
    });
  });

  it("books exactly one next run after a FAILED run — a failure must not skip or duplicate the schedule", async () => {
    const { client, updates } = stubClient("running");
    await markDiscoveryFinished(client, "campaign-1", "org-1", { ok: false, error: "Tavily timed out" });

    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({
      discovery_state: "failed",
      discovery_next_run_at: nextDiscoveryRunAt(NOW),
      discovery_last_error: "Tavily timed out",
    });
  });

  it("does not revive a campaign stopped while the run was in flight", async () => {
    const { client, updates } = stubClient("stopped");
    await markDiscoveryFinished(client, "campaign-1", "org-1", { ok: true });

    expect(updates).toHaveLength(0);
  });

  it("truncates a very long provider error rather than storing it whole", async () => {
    const { client, updates } = stubClient("running");
    await markDiscoveryFinished(client, "campaign-1", "org-1", { ok: false, error: "x".repeat(900) });

    expect(String(updates[0].values.discovery_last_error)).toHaveLength(500);
  });
});

describe("stopCampaignDiscovery / resumeCampaignDiscovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stopping clears the pending slot so no future run can be picked up", async () => {
    const { client, updates } = stubClient();
    const ok = await stopCampaignDiscovery(client, "campaign-1", "org-1");

    expect(ok).toBe(true);
    expect(updates[0].values).toEqual({ discovery_state: "stopped", discovery_next_run_at: null });
    expect(isDiscoveryDue({ discovery_state: "stopped", discovery_next_run_at: null }, NOW)).toBe(false);
  });

  it("resuming books the campaign as due now, so the cycle restarts on the next sweep", async () => {
    const { client, updates } = stubClient();
    const ok = await resumeCampaignDiscovery(client, "campaign-1", "org-1");

    expect(ok).toBe(true);
    expect(updates[0].values).toEqual({
      discovery_state: "scheduled",
      discovery_next_run_at: NOW.toISOString(),
      discovery_last_error: null,
    });
    expect(isDiscoveryDue({ discovery_state: "scheduled", discovery_next_run_at: NOW.toISOString() }, NOW)).toBe(true);
  });

  it("stop then resume returns the campaign to a due, runnable state", async () => {
    const { client } = stubClient();
    await stopCampaignDiscovery(client, "campaign-1", "org-1");
    await resumeCampaignDiscovery(client, "campaign-1", "org-1");

    expect(isDiscoveryDue({ discovery_state: "scheduled", discovery_next_run_at: NOW.toISOString() }, NOW)).toBe(true);
  });
});
