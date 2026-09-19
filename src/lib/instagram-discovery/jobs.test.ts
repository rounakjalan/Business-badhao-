import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/instagram-discovery/connection", () => ({ getUsableInstagramDiscoveryProfileRef: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getUsableInstagramDiscoveryProfileRef } from "@/lib/instagram-discovery/connection";
import {
  claimNextInstagramDiscoveryJob,
  completeInstagramDiscoveryJob,
  createInstagramDiscoveryJob,
  pollInstagramDiscoveryJobResult,
} from "@/lib/instagram-discovery/jobs";

type Row = Record<string, unknown>;
type Filter = [string, unknown, "eq" | "gt"];

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([col, val, op]) => (op === "eq" ? row[col] === val : (row[col] as string) > (val as string)));
}

function makeFakeAdmin(initialRows: Row[] = []) {
  const rows: Row[] = [...initialRows];
  let idCounter = 0;

  function selectBuilder(filters: Filter[] = []) {
    const builder = {
      eq: (col: string, val: unknown) => selectBuilder([...filters, [col, val, "eq"]]),
      gt: (col: string, val: unknown) => selectBuilder([...filters, [col, val, "gt"]]),
      order: () => builder,
      limit: async (n: number) => ({ data: rows.filter((r) => matches(r, filters)).slice(0, n), error: null }),
      maybeSingle: async () => ({ data: rows.find((r) => matches(r, filters)) ?? null, error: null }),
    };
    return builder;
  }

  function updateBuilder(values: Row, filters: Filter[] = []) {
    return {
      eq: (col: string, val: unknown) => updateBuilder(values, [...filters, [col, val, "eq"]]),
      select: () => ({
        maybeSingle: async () => {
          const target = rows.find((r) => matches(r, filters));
          if (!target) return { data: null, error: null };
          Object.assign(target, values);
          return { data: { ...target }, error: null };
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

  it("creates a pending job scoped to the given organization with the query as its criteria", async () => {
    const admin = makeFakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const job = await createInstagramDiscoveryJob("org-1", "boutique clothing shops Jaipur");

    expect(job).not.toBeNull();
    const row = admin.__rows()[0];
    expect(row).toMatchObject({ organization_id: "org-1", status: "pending", criteria: { query: "boutique clothing shops Jaipur" } });
    expect(row.expires_at).toBeTruthy();
  });

  it("returns null when automation isn't configured, rather than throwing", async () => {
    vi.mocked(createAdminClient).mockReturnValue(null);
    const job = await createInstagramDiscoveryJob("org-1", "q");
    expect(job).toBeNull();
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
      { id: "job-1", organization_id: "org-1", status: "pending", criteria: { query: "q" }, expires_at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue(null);

    const claimed = await claimNextInstagramDiscoveryJob();

    expect(claimed).toBeNull();
    expect(admin.__rows()[0].status).toBe("pending"); // left untouched, not silently claimed
  });

  it("claims the oldest usable pending job and returns its organization's real browser profile ref", async () => {
    const admin = makeFakeAdmin([
      { id: "job-1", organization_id: "org-1", status: "pending", criteria: { query: "retail shops Jaipur" }, expires_at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue("org-1");

    const claimed = await claimNextInstagramDiscoveryJob();

    expect(claimed).toEqual({ id: "job-1", organizationId: "org-1", query: "retail shops Jaipur", browserProfileRef: "org-1" });
    expect(admin.__rows()[0]).toMatchObject({ status: "claimed" });
  });

  it("skips a pending job that has already expired", async () => {
    const admin = makeFakeAdmin([
      { id: "job-1", organization_id: "org-1", status: "pending", criteria: { query: "q" }, expires_at: new Date(Date.now() - 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue("org-1");

    expect(await claimNextInstagramDiscoveryJob()).toBeNull();
  });

  it("never re-claims a job that is already claimed", async () => {
    const admin = makeFakeAdmin([
      { id: "job-1", organization_id: "org-1", status: "claimed", criteria: { query: "q" }, expires_at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);
    vi.mocked(getUsableInstagramDiscoveryProfileRef).mockResolvedValue("org-1");

    expect(await claimNextInstagramDiscoveryJob()).toBeNull();
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
