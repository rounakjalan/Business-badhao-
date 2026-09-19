import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/instagram-discovery/connection", () => ({ getUsableInstagramDiscoveryProfileRef: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getUsableInstagramDiscoveryProfileRef } from "@/lib/instagram-discovery/connection";
import {
  claimNextInstagramDiscoveryJob,
  completeInstagramDiscoveryJob,
  createInstagramDiscoveryJob,
  createInstagramDiscoveryVerificationJob,
  getInstagramDiscoveryQueueStats,
  pollInstagramDiscoveryJobResult,
  reclaimStaleInstagramDiscoveryJobs,
} from "@/lib/instagram-discovery/jobs";

type Row = Record<string, unknown>;
type Op = "eq" | "gt" | "gte" | "lt" | "in";
type Filter = [string, unknown, Op];

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([col, val, op]) => {
    if (op === "eq") return row[col] === val;
    if (op === "in") return (val as unknown[]).includes(row[col]);
    const rowVal = row[col] as string;
    const cmpVal = val as string;
    if (op === "gt") return rowVal > cmpVal;
    if (op === "gte") return rowVal >= cmpVal;
    return rowVal < cmpVal;
  });
}

function makeFakeAdmin(initialRows: Row[] = []) {
  const rows: Row[] = [...initialRows];
  let idCounter = 0;

  function selectBuilder(filters: Filter[] = []) {
    const builder = {
      eq: (col: string, val: unknown) => selectBuilder([...filters, [col, val, "eq"]]),
      gt: (col: string, val: unknown) => selectBuilder([...filters, [col, val, "gt"]]),
      gte: (col: string, val: unknown) => selectBuilder([...filters, [col, val, "gte"]]),
      lt: (col: string, val: unknown) => selectBuilder([...filters, [col, val, "lt"]]),
      in: (col: string, vals: unknown[]) => selectBuilder([...filters, [col, vals, "in"]]),
      order: () => builder,
      limit: async (n: number) => ({ data: rows.filter((r) => matches(r, filters)).slice(0, n), error: null }),
      maybeSingle: async () => ({ data: rows.find((r) => matches(r, filters)) ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => void) => resolve({ data: rows.filter((r) => matches(r, filters)), error: null }),
    };
    return builder;
  }

  function updateBuilder(values: Row, filters: Filter[] = []) {
    return {
      eq: (col: string, val: unknown) => updateBuilder(values, [...filters, [col, val, "eq"]]),
      in: (col: string, vals: unknown[]) => updateBuilder(values, [...filters, [col, vals, "in"]]),
      lt: (col: string, val: unknown) => updateBuilder(values, [...filters, [col, val, "lt"]]),
      select: () => ({
        maybeSingle: async () => {
          const target = rows.find((r) => matches(r, filters));
          if (!target) return { data: null, error: null };
          Object.assign(target, values);
          return { data: { ...target }, error: null };
        },
        then: (resolve: (v: { data: { id: unknown }[]; error: null }) => void) => {
          const targets = rows.filter((r) => matches(r, filters));
          for (const target of targets) Object.assign(target, values);
          resolve({ data: targets.map((t) => ({ id: t.id })), error: null });
        },
      }),
    };
  }

  const from = () => ({
    insert: (values: Row) => ({
      select: () => ({
        maybeSingle: async () => {
          const row: Row = {
            id: `job-${++idCounter}`,
            status: "pending",
            candidates: null,
            error: null,
            claimed_at: null,
            completed_at: null,
            created_at: new Date().toISOString(),
            ...values,
          };
          rows.push(row);
          return { data: { id: row.id }, error: null };
        },
      }),
    }),
    select: () => selectBuilder(),
    update: (values: Row) => updateBuilder(values),
  });

  return { from, __rows: () => rows } as unknown as ReturnType<typeof createAdminClient> & { __rows: () => Row[] };
}

describe("createInstagramDiscoveryJob", () => {
  afterEach(() => vi.resetAllMocks());

  it("creates a pending search job scoped to the given organization", async () => {
    const admin = makeFakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const job = await createInstagramDiscoveryJob("org-1", "boutique clothing shops Jaipur");

    expect(job).not.toBeNull();
    const row = admin.__rows()[0];
    expect(row).toMatchObject({ organization_id: "org-1", status: "pending", criteria: { type: "search", query: "boutique clothing shops Jaipur" } });
    expect(row.expires_at).toBeTruthy();
  });

  it("returns null when automation isn't configured, rather than throwing", async () => {
    vi.mocked(createAdminClient).mockReturnValue(null);
    const job = await createInstagramDiscoveryJob("org-1", "q");
    expect(job).toBeNull();
  });
});

describe("createInstagramDiscoveryVerificationJob", () => {
  afterEach(() => vi.resetAllMocks());

  it("creates a pending verify job with no query, scoped to the given organization", async () => {
    const admin = makeFakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const job = await createInstagramDiscoveryVerificationJob("org-1");

    expect(job).not.toBeNull();
    expect(admin.__rows()[0]).toMatchObject({ organization_id: "org-1", status: "pending", criteria: { type: "verify" } });
  });
});

describe("claimNextInstagramDiscoveryJob", () => {
  afterEach(() => vi.resetAllMocks());

  it("returns null when there is nothing pending", async () => {
    vi.mocked(createAdminClient).mockReturnValue(makeFakeAdmin([]));
    expect(await claimNextInstagramDiscoveryJob()).toBeNull();
  });

  it("never claims a job for an organization whose connection isn't actually usable", async () => {
    const admin = makeFakeAdmin([
      { id: "job-1", organization_id: "org-1", status: "pending", criteria: { type: "search", query: "q" }, expires_at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue(null);

    const claimed = await claimNextInstagramDiscoveryJob();

    expect(claimed).toBeNull();
    expect(admin.__rows()[0].status).toBe("pending"); // left untouched, not silently claimed
  });

  it("claims the oldest usable pending search job and returns its organization's real browser profile ref", async () => {
    const admin = makeFakeAdmin([
      { id: "job-1", organization_id: "org-1", status: "pending", criteria: { type: "search", query: "retail shops Jaipur" }, expires_at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue("org-1");

    const claimed = await claimNextInstagramDiscoveryJob();

    expect(claimed).toEqual({ id: "job-1", organizationId: "org-1", type: "search", query: "retail shops Jaipur", browserProfileRef: "org-1" });
    expect(admin.__rows()[0]).toMatchObject({ status: "claimed" });
  });

  it("claims a verify job with no query field", async () => {
    const admin = makeFakeAdmin([
      { id: "job-1", organization_id: "org-1", status: "pending", criteria: { type: "verify" }, expires_at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue("org-1");

    const claimed = await claimNextInstagramDiscoveryJob();

    expect(claimed).toEqual({ id: "job-1", organizationId: "org-1", type: "verify", browserProfileRef: "org-1" });
  });

  it("skips a pending job that has already expired", async () => {
    const admin = makeFakeAdmin([
      { id: "job-1", organization_id: "org-1", status: "pending", criteria: { type: "search", query: "q" }, expires_at: new Date(Date.now() - 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue("org-1");

    expect(await claimNextInstagramDiscoveryJob()).toBeNull();
  });

  it("never re-claims a job that is already claimed", async () => {
    const admin = makeFakeAdmin([
      { id: "job-1", organization_id: "org-1", status: "claimed", criteria: { type: "search", query: "q" }, expires_at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue("org-1");

    expect(await claimNextInstagramDiscoveryJob()).toBeNull();
  });

  it("sweeps a stale claimed job (expired, never completed by a crashed worker) before claiming — it never blocks new work", async () => {
    const admin = makeFakeAdmin([
      { id: "job-stale", organization_id: "org-1", status: "claimed", criteria: { type: "search", query: "old" }, expires_at: new Date(Date.now() - 60_000).toISOString() },
      { id: "job-new", organization_id: "org-1", status: "pending", criteria: { type: "search", query: "new" }, expires_at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue("org-1");

    const claimed = await claimNextInstagramDiscoveryJob();

    expect(claimed).toMatchObject({ id: "job-new" });
    expect(admin.__rows().find((r) => r.id === "job-stale")).toMatchObject({ status: "expired" });
  });
});

describe("reclaimStaleInstagramDiscoveryJobs", () => {
  afterEach(() => vi.resetAllMocks());

  it("marks overdue pending/claimed jobs as expired and leaves live ones untouched", async () => {
    const admin = makeFakeAdmin([
      { id: "job-1", status: "pending", expires_at: new Date(Date.now() - 1000).toISOString() },
      { id: "job-2", status: "claimed", expires_at: new Date(Date.now() - 1000).toISOString() },
      { id: "job-3", status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString() },
      { id: "job-4", status: "completed", expires_at: new Date(Date.now() - 1000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const count = await reclaimStaleInstagramDiscoveryJobs();

    expect(count).toBe(2);
    expect(admin.__rows().find((r) => r.id === "job-1")).toMatchObject({ status: "expired" });
    expect(admin.__rows().find((r) => r.id === "job-2")).toMatchObject({ status: "expired" });
    expect(admin.__rows().find((r) => r.id === "job-3")).toMatchObject({ status: "pending" });
    expect(admin.__rows().find((r) => r.id === "job-4")).toMatchObject({ status: "completed" });
  });

  it("returns 0 when automation isn't configured", async () => {
    vi.mocked(createAdminClient).mockReturnValue(null);
    expect(await reclaimStaleInstagramDiscoveryJobs()).toBe(0);
  });
});

describe("completeInstagramDiscoveryJob", () => {
  afterEach(() => vi.resetAllMocks());

  it("records real candidates and marks a claimed job completed", async () => {
    const admin = makeFakeAdmin([{ id: "job-1", organization_id: "org-1", status: "claimed" }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const candidates = [{ username: "biz_official", profileUrl: "https://www.instagram.com/biz_official/" }];
    const result = await completeInstagramDiscoveryJob({ jobId: "job-1", status: "completed", candidates });

    expect(result).toEqual({ ok: true });
    expect(admin.__rows()[0]).toMatchObject({ status: "completed", candidates });
  });

  it("records an honest failure without fabricating candidates", async () => {
    const admin = makeFakeAdmin([{ id: "job-1", organization_id: "org-1", status: "claimed" }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await completeInstagramDiscoveryJob({ jobId: "job-1", status: "failed", error: "Instagram session expired" });

    expect(result).toEqual({ ok: true });
    expect(admin.__rows()[0]).toMatchObject({ status: "failed", error: "Instagram session expired", candidates: null });
  });

  it("rejects a report for a job that is not currently claimed — never silently overwrites a result its caller gave up on", async () => {
    const admin = makeFakeAdmin([{ id: "job-1", organization_id: "org-1", status: "completed", candidates: [] }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await completeInstagramDiscoveryJob({ jobId: "job-1", status: "completed", candidates: [{ username: "x", profileUrl: "https://instagram.com/x/" }] });

    expect(result).toEqual({ ok: false, code: "not_claimed", message: expect.any(String) });
  });
});

describe("pollInstagramDiscoveryJobResult", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it("returns real candidates the moment the job is already completed", async () => {
    const candidates = [{ username: "biz_official", profileUrl: "https://www.instagram.com/biz_official/" }];
    vi.mocked(createAdminClient).mockReturnValue(makeFakeAdmin([{ id: "job-1", status: "completed", candidates, error: null }]));

    const result = await pollInstagramDiscoveryJobResult("job-1", 5000);

    expect(result).toEqual({ ok: true, candidates });
  });

  it("reports the runtime's own real failure message rather than fabricating a result", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeFakeAdmin([{ id: "job-1", status: "failed", candidates: null, error: "Instagram session expired" }])
    );

    const result = await pollInstagramDiscoveryJobResult("job-1", 5000);

    expect(result).toEqual({ ok: false, message: "Instagram session expired" });
  });

  it("honestly times out rather than waiting forever when the runtime never answers", async () => {
    vi.useFakeTimers();
    vi.mocked(createAdminClient).mockReturnValue(makeFakeAdmin([{ id: "job-1", status: "pending", candidates: null, error: null }]));

    const resultPromise = pollInstagramDiscoveryJobResult("job-1", 5000);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, message: "The Instagram discovery runtime did not respond within the allotted time." });
  });
});

describe("getInstagramDiscoveryQueueStats", () => {
  afterEach(() => vi.resetAllMocks());

  it("counts current pending/claimed jobs regardless of age, and recent terminal states within 24h", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const admin = makeFakeAdmin([
      { id: "1", status: "pending", created_at: old },
      { id: "2", status: "claimed", created_at: recent },
      { id: "3", status: "completed", created_at: recent },
      { id: "4", status: "completed", created_at: old }, // outside the 24h window — excluded
      { id: "5", status: "failed", created_at: recent },
      { id: "6", status: "expired", created_at: recent },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const stats = await getInstagramDiscoveryQueueStats();

    expect(stats).toEqual({ pending: 1, claimed: 1, completedLast24h: 1, failedLast24h: 1, expiredLast24h: 1 });
  });

  it("returns null when automation isn't configured, rather than throwing", async () => {
    vi.mocked(createAdminClient).mockReturnValue(null);
    expect(await getInstagramDiscoveryQueueStats()).toBeNull();
  });
});
