import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Proves runBatchedDiscovery's own orchestration logic in isolation from the
// real AI/search pipeline (that end-to-end wiring is already proven by
// scheduled-pipeline.test.ts and actions.discovery-research.test.ts, which
// run the real discover() through real HTTP mocks). This file mocks only
// discover() itself (via getDiscoveryProvider) and contact enrichment, so
// each stop-reason branch, the cross-batch dedup, and excludeQueries growth
// can be driven deterministically and cheaply.

vi.mock("@/lib/ai/agents/discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/agents/discovery")>();
  return { ...actual, getDiscoveryProvider: vi.fn() };
});

vi.mock("@/lib/discovery/contact-enrichment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discovery/contact-enrichment")>();
  return { ...actual, discoverProspectContacts: vi.fn() };
});

import { getDiscoveryProvider, type DiscoveredProspect, type DiscoveryProvider, type DiscoveryResult } from "@/lib/ai/agents/discovery";
import { discoverProspectContacts } from "@/lib/discovery/contact-enrichment";
import { runBatchedDiscovery } from "@/lib/pipeline/discovery-batch";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

// Same generic in-memory Supabase stand-in as scheduled-pipeline.test.ts,
// duplicated per this codebase's own convention of a small local fake per
// test file (see deals/actions.quick-task.test.ts).
function createFakeSupabase(tables: Tables) {
  let counter = 0;

  function builder(table: string) {
    tables[table] = tables[table] ?? [];
    const filters: ((row: Row) => boolean)[] = [];
    let pendingInsert: Row | Row[] | null = null;

    function execute(): Row[] {
      if (pendingInsert) {
        const items = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        const inserted = items.map((item) => ({ id: `${table}-${++counter}`, created_at: new Date().toISOString(), ...item }));
        tables[table].push(...inserted);
        return inserted;
      }
      return tables[table].filter((row) => filters.every((f) => f(row)));
    }

    const api = {
      select() {
        return api;
      },
      insert(payload: Row | Row[]) {
        pendingInsert = payload;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return api;
      },
      async maybeSingle() {
        const rows = execute();
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const rows = execute();
        return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "no matching row" } };
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: execute(), error: null });
      },
    };

    return api;
  }

  return { from: (table: string) => builder(table) } as never;
}

function prospect(overrides: Partial<DiscoveredProspect> & { companyName: string }): DiscoveredProspect {
  return {
    website: null,
    location: "Pune",
    industry: "Web Design",
    businessType: "Agency",
    email: null,
    phone: null,
    sourceUrl: `https://directory.example/${overrides.companyName}`,
    evidenceSnippet: `${overrides.companyName} is a real business found in a real search result.`,
    matchedIcpCriteria: ["industry: Web Design"],
    searchQuery: "web design Pune",
    ...overrides,
  };
}

function okResult(prospects: DiscoveredProspect[], queriesRun: string[] = ["q"]): DiscoveryResult {
  return { ok: true, prospects, queriesRun, queriesFailed: [] };
}

function baseParams(discoverMock: DiscoveryProvider["discover"], overrides: Partial<Parameters<typeof runBatchedDiscovery>[0]> = {}) {
  const tables: Tables = {};
  const supabase = createFakeSupabase(tables);
  vi.mocked(getDiscoveryProvider).mockReturnValue({
    name: "tavily",
    isConfigured: () => true,
    discover: discoverMock,
  });
  return {
    tables,
    params: {
      supabase,
      organizationId: "org-1",
      campaignId: "campaign-1",
      campaignName: "Pune Web Design Push",
      campaignObjective: "Find web design agencies",
      icpCriteria: { location: "Pune", industry: "Web Design" },
      businessContext: null,
      startedAtMs: Date.now(),
      budgetMs: 240_000,
      agentRun: null,
      ...overrides,
    },
  };
}

describe("runBatchedDiscovery", () => {
  beforeEach(() => {
    vi.mocked(discoverProspectContacts).mockResolvedValue({ contacts: null, status: "not_found" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps calling discover() across multiple batches to reach a target well above what a single batch itself returned", async () => {
    const discoverMock = vi
      .fn()
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Alpha" }), prospect({ companyName: "Beta" })], ["q1"]))
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Gamma" }), prospect({ companyName: "Delta" })], ["q2"]))
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Epsilon" }), prospect({ companyName: "Zeta" })], ["q3"]));

    const { tables, params } = baseParams(discoverMock, { targetNewLeads: 5, maxBatches: 6 });
    const result = await runBatchedDiscovery(params);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(discoverMock).toHaveBeenCalledTimes(3);
    expect(result.batchesRun).toBe(3);
    expect(result.stoppedReason).toBe("target_reached");
    // Target of 5 is reached mid-third-batch (2 + 2 + 1) — the run stops as
    // soon as it hits the target rather than always finishing a whole batch.
    expect(result.newLeadsCreated).toBe(5);
    expect((tables.leads ?? []).length).toBe(5);
  });

  it("fires onLeadPersisted the instant each lead is persisted — before the next batch's own discover() call, not batched up until the whole run ends", async () => {
    const events: string[] = [];
    const discoverMock = vi.fn().mockImplementation(async () => {
      const callNumber = events.filter((e) => e === "discover() called").length + 1;
      events.push("discover() called");
      return callNumber === 1 ? okResult([prospect({ companyName: "Alpha" }), prospect({ companyName: "Beta" })]) : okResult([]);
    });

    const { params } = baseParams(discoverMock, { targetNewLeads: 25, maxBatches: 2 });
    await runBatchedDiscovery({
      ...params,
      onLeadPersisted: (leadId) => events.push(`persisted:${leadId}`),
    });

    // Both leads from batch 1 are persisted (and the callback fires for
    // each) strictly before batch 2's own discover() call — proving
    // research can start on them while discovery is still going, not only
    // after runBatchedDiscovery itself returns.
    const discoverIndices = events.flatMap((e, i) => (e === "discover() called" ? [i] : []));
    const persistedIndices = events.flatMap((e, i) => (e.startsWith("persisted:") ? [i] : []));
    expect(discoverIndices).toHaveLength(2);
    expect(persistedIndices).toHaveLength(2);
    expect(Math.max(...persistedIndices)).toBeLessThan(discoverIndices[1]);
  });

  it("a research-side failure in onLeadPersisted (e.g. the worker pool's own job throwing) never aborts discovery or loses a batch's already-persisted leads", async () => {
    const discoverMock = vi
      .fn()
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Alpha" }), prospect({ companyName: "Beta" })]))
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Gamma" })]))
      .mockResolvedValue(okResult([]));

    const { tables, params } = baseParams(discoverMock, { targetNewLeads: 25, maxBatches: 3 });
    const result = await runBatchedDiscovery({
      ...params,
      // Simulates a worker pool whose enqueue synchronously throws (a bug
      // in the pool, or a caller not wrapping it) — discovery must still
      // finish normally and keep every lead it already persisted.
      onLeadPersisted: () => {
        throw new Error("simulated pool failure");
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newLeadsCreated).toBe(3);
    expect((tables.leads ?? []).length).toBe(3);
  });

  it("stops after two consecutive empty batches (no_more_results), never discarding what an earlier batch already found", async () => {
    // Batch 2 and 3 return the exact same two prospects as batch 1 — once
    // cross-batch dedup has already seen them, these batches are genuinely
    // empty of anything NEW, not merely small.
    const repeat = () => okResult([prospect({ companyName: "Alpha" }), prospect({ companyName: "Beta" })]);
    const discoverMock = vi.fn().mockResolvedValueOnce(repeat()).mockResolvedValueOnce(repeat()).mockResolvedValueOnce(repeat());

    const { tables, params } = baseParams(discoverMock, { targetNewLeads: 25, maxBatches: 6 });
    const result = await runBatchedDiscovery(params);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batchesRun).toBe(3);
    expect(result.stoppedReason).toBe("no_more_results");
    expect(result.newLeadsCreated).toBe(2);
    expect(result.duplicatesSkipped).toBe(4);
    // The two leads from batch 1 are still there — a later batch turning up
    // nothing new never throws away what an earlier one already persisted.
    expect((tables.leads ?? []).length).toBe(2);
  });

  it("records a single batch's own provider error and continues, preserving earlier batches' already-persisted leads", async () => {
    const discoverMock = vi
      .fn()
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Alpha" })]))
      .mockResolvedValueOnce({ ok: false, code: "provider_error", message: "Tavily timed out" } as DiscoveryResult)
      .mockResolvedValueOnce({ ok: false, code: "provider_error", message: "Tavily timed out" } as DiscoveryResult);

    const { tables, params } = baseParams(discoverMock, { targetNewLeads: 25, maxBatches: 6 });
    const result = await runBatchedDiscovery(params);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batchesRun).toBe(3);
    expect(result.stoppedReason).toBe("provider_error");
    expect(result.newLeadsCreated).toBe(1);
    expect((tables.leads ?? []).length).toBe(1);
    expect(result.queriesFailed.some((q) => q.includes("Tavily timed out"))).toBe(true);
  });

  it("a single rate-limited batch never terminates the whole run — the very next batch recovering is enough to finish successfully, target reached", async () => {
    const discoverMock = vi
      .fn()
      // The exact failure shape a rate-limited Hermes/Groq call surfaces as
      // at the discover() layer (see TavilyDiscoveryProvider.discover in
      // discovery.ts) — generateDiscoveryQueries/extraction/the Reviewer
      // all report their own failure this same way.
      .mockResolvedValueOnce({ ok: false, code: "provider_error", message: "The AI provider is rate-limiting requests right now — try again shortly." } as DiscoveryResult)
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Alpha" }), prospect({ companyName: "Beta" })]));

    const { tables, params } = baseParams(discoverMock, { targetNewLeads: 2, maxBatches: 6 });
    const result = await runBatchedDiscovery(params);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One 429 in batch 1 cost nothing but that one batch — batch 2 still ran,
    // still found real prospects, and the run reports its normal success
    // stop reason, never a failure just because an earlier batch hit a
    // transient rate limit.
    expect(result.batchesRun).toBe(2);
    expect(result.stoppedReason).toBe("target_reached");
    expect(result.newLeadsCreated).toBe(2);
    expect((tables.leads ?? []).length).toBe(2);
    expect(result.queriesFailed.some((q) => q.includes("rate-limiting"))).toBe(true);
  });

  it("reports a genuine failure (never a false success) when not even one batch ever found anything", async () => {
    const discoverMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "provider_error", message: "Tavily is down" } as DiscoveryResult)
      .mockResolvedValueOnce({ ok: false, code: "provider_error", message: "Tavily is down" } as DiscoveryResult);

    const { params } = baseParams(discoverMock, { targetNewLeads: 25, maxBatches: 6 });
    const result = await runBatchedDiscovery(params);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("provider_error");
    expect(result.message).toBe("Tavily is down");
  });

  it("short-circuits to not_configured immediately, without ever calling discover()", async () => {
    const discoverMock = vi.fn();
    const { params } = baseParams(discoverMock);
    vi.mocked(getDiscoveryProvider).mockReturnValue({
      name: "tavily",
      isConfigured: () => false,
      discover: discoverMock,
    });

    const result = await runBatchedDiscovery(params);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_configured");
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("asks the Reasoner to avoid queries already tried — excludeQueries grows with every prior batch's own queries within the same run", async () => {
    // A batch that finds nothing new resets nothing about the exclude list,
    // but two of those in a row would stop the run — so batches 1 and 3 each
    // add one new prospect (resetting the empty-batch counter) purely to
    // keep batch 3 from being skipped, while what's under test is only the
    // excludeQueries argument each call actually receives.
    const discoverMock = vi
      .fn()
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Alpha" })], ["query about Pune agencies"]))
      .mockResolvedValueOnce(okResult([], ["query about Mumbai agencies"]))
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Beta" })], ["query about Delhi agencies"]));

    const { params } = baseParams(discoverMock, { targetNewLeads: 25, maxBatches: 3 });
    await runBatchedDiscovery(params);

    expect(discoverMock).toHaveBeenCalledTimes(3);
    expect(discoverMock.mock.calls[0][0].excludeQueries).toBeUndefined();
    expect(discoverMock.mock.calls[1][0].excludeQueries).toEqual(["query about Pune agencies"]);
    expect(discoverMock.mock.calls[2][0].excludeQueries).toEqual(["query about Pune agencies", "query about Mumbai agencies"]);
  });

  it("never re-persists a prospect that already exists from an earlier discovery run for this organization", async () => {
    const discoverMock = vi
      .fn()
      .mockResolvedValueOnce(okResult([prospect({ companyName: "Alpha", website: "alpha.example" })]))
      .mockResolvedValue(okResult([]));

    const { tables, params } = baseParams(discoverMock, { targetNewLeads: 25, maxBatches: 3 });
    tables.prospects = [{ id: "prospect-existing", organization_id: "org-1", company_name: "Alpha", website: "alpha.example" }];

    const result = await runBatchedDiscovery(params);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newLeadsCreated).toBe(0);
    expect(result.duplicatesSkipped).toBe(1);
    expect((tables.leads ?? []).length).toBe(0);
  });
});
