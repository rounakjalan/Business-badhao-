import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Proves createLeadWorkerPool's own orchestration in isolation from the real
// AI pipeline (that end-to-end wiring is proven by scheduled-pipeline.test.ts
// and actions.discovery-research.test.ts, which run the real researchLead/
// qualifyLead against real HTTP mocks). This file mocks only
// researchLead/qualifyLead/sendAutomaticWhatsAppOutreach (lead-pipeline.ts),
// so concurrency, timeout isolation, duplicate protection, and the time
// budget can each be driven deterministically and cheaply.

vi.mock("@/lib/pipeline/lead-pipeline", () => ({
  researchLead: vi.fn(),
  qualifyLead: vi.fn(),
  sendAutomaticWhatsAppOutreach: vi.fn(),
}));

import { qualifyLead, researchLead, sendAutomaticWhatsAppOutreach } from "@/lib/pipeline/lead-pipeline";
import { createLeadWorkerPool } from "@/lib/pipeline/lead-worker-pool";

const supabase = {} as never; // Never actually queried by the pool itself — every DB call lives inside the (mocked) lead-pipeline functions, except runOneLead's own "is this lead already completed" pre-check.

function baseParams(overrides: Partial<Parameters<typeof createLeadWorkerPool>[0]> = {}) {
  return { supabase, organizationId: "org-1", startedAtMs: Date.now(), budgetMs: 60_000, ...overrides };
}

/** A controllable "researchLead" that resolves after `ms`, tracking concurrent in-flight calls. */
function makeDelayedResearch(ms: number, active: { current: number; peak: number }) {
  return vi.fn(async () => {
    active.current += 1;
    active.peak = Math.max(active.peak, active.current);
    await new Promise((resolve) => setTimeout(resolve, ms));
    active.current -= 1;
    return { ok: true, research: {} };
  });
}

describe("createLeadWorkerPool", () => {
  beforeEach(() => {
    // A lead with no "already completed" row on file by default — every
    // test below wants researchLead actually attempted.
    vi.mocked(researchLead).mockImplementation(async () => ({ ok: true, research: {} }) as never);
    vi.mocked(qualifyLead).mockImplementation(async () => ({ ok: true, qualification: { recommendedStatus: "qualifying" } }) as never);
    vi.mocked(sendAutomaticWhatsAppOutreach).mockImplementation(async () => ({ attempted: false, channel: "none", reason: "not_found" }) as never);
    (supabase as unknown as { from: () => unknown }).from = () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { research_status: "pending" } }) }) }) }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("enqueue() returns immediately without waiting for the research call itself", async () => {
    let resolveResearch: (() => void) | null = null;
    vi.mocked(researchLead).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResearch = () => resolve({ ok: true, research: {} } as never);
        })
    );

    const pool = createLeadWorkerPool(baseParams());
    const order: string[] = [];
    order.push("before enqueue");
    pool.enqueue("lead-1");
    order.push("after enqueue"); // Reached synchronously — enqueue never awaited any part of the job.

    expect(order).toEqual(["before enqueue", "after enqueue"]);
    // The caller (e.g. discovery's own persist loop) is free to keep going
    // immediately — the job itself is still in flight, proven by drain()
    // only resolving once it's deliberately let finish below.
    let drained = false;
    void pool.drain().then(() => {
      drained = true;
    });
    // Flush pending microtasks (the pool's own pre-check read) so
    // researchLead has actually been reached before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);
    expect(resolveResearch).not.toBeNull();

    resolveResearch!();
    await pool.drain();
    expect(drained).toBe(true);
  });

  it("researches multiple leads concurrently, up to the configured bound — never one at a time", async () => {
    const active = { current: 0, peak: 0 };
    vi.mocked(researchLead).mockImplementation(makeDelayedResearch(30, active) as never);

    const pool = createLeadWorkerPool(baseParams({ concurrency: 3 }));
    pool.enqueue("lead-1");
    pool.enqueue("lead-2");
    pool.enqueue("lead-3");
    pool.enqueue("lead-4");
    pool.enqueue("lead-5");

    await pool.drain();

    expect(researchLead).toHaveBeenCalledTimes(5);
    // With 5 leads and a limit of 3, real concurrency must have reached the
    // bound at some point — proving genuine parallelism, not accidental
    // seriality that happened to finish before the assertion ran.
    expect(active.peak).toBe(3);
    expect(pool.summary.finished).toBe(5);
  });

  it("never exceeds the configured concurrency limit, even with many more leads than the bound", async () => {
    const active = { current: 0, peak: 0 };
    vi.mocked(researchLead).mockImplementation(makeDelayedResearch(20, active) as never);

    const pool = createLeadWorkerPool(baseParams({ concurrency: 2 }));
    for (let i = 0; i < 10; i++) pool.enqueue(`lead-${i}`);
    await pool.drain();

    expect(active.peak).toBeLessThanOrEqual(2);
    expect(active.peak).toBe(2);
    expect(pool.summary.finished).toBe(10);
  });

  it("one lead's research failure (or timeout) never stops another lead's own job, and drain() still resolves", async () => {
    vi.mocked(researchLead).mockImplementation(async (_supabase: unknown, _org: unknown, leadId: unknown) => {
      if (leadId === "lead-bad") throw new Error("simulated timeout");
      return { ok: true, research: {} } as never;
    });

    const pool = createLeadWorkerPool(baseParams({ concurrency: 3 }));
    pool.enqueue("lead-good-1");
    pool.enqueue("lead-bad");
    pool.enqueue("lead-good-2");
    await pool.drain();

    expect(pool.summary.finished).toBe(2);
    expect(pool.summary.failed).toBe(1);
  });

  it("a lead whose researchLead call reports it's already being researched elsewhere is skipped, not counted as a failure", async () => {
    vi.mocked(researchLead).mockResolvedValue({ ok: false, message: "This lead is already being researched.", code: "already_in_progress" } as never);

    const pool = createLeadWorkerPool(baseParams());
    pool.enqueue("lead-1");
    await pool.drain();

    expect(pool.summary.skippedAlreadyInProgress).toBe(1);
    expect(pool.summary.failed).toBe(0);
    expect(qualifyLead).not.toHaveBeenCalled();
  });

  it("never runs two jobs for the same lead at once within one pool instance — a second enqueue while the first is still in flight is a no-op", async () => {
    const active = { current: 0, peak: 0 };
    vi.mocked(researchLead).mockImplementation(makeDelayedResearch(30, active) as never);

    const pool = createLeadWorkerPool(baseParams());
    pool.enqueue("lead-1");
    pool.enqueue("lead-1"); // Duplicate, while the first job is still running.
    pool.enqueue("lead-1"); // Duplicate again.
    await pool.drain();

    expect(researchLead).toHaveBeenCalledTimes(1);
    expect(pool.summary.finished).toBe(1);
  });

  it("a lead already researched (research_status: 'completed') is never re-researched — only qualification runs", async () => {
    (supabase as unknown as { from: () => unknown }).from = () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { research_status: "completed" } }) }) }) }),
    });

    const pool = createLeadWorkerPool(baseParams());
    pool.enqueue("lead-1");
    await pool.drain();

    expect(researchLead).not.toHaveBeenCalled();
    expect(qualifyLead).toHaveBeenCalledTimes(1);
    expect(pool.summary.finished).toBe(1);
  });

  it("stops starting new jobs once its own time budget is spent, without aborting jobs already running — the unstarted ones are simply never attempted", async () => {
    const active = { current: 0, peak: 0 };
    vi.mocked(researchLead).mockImplementation(makeDelayedResearch(10, active) as never);

    // startedAtMs far enough in the past that outOfTime() is already true —
    // simulates a pool created with almost no budget left.
    const pool = createLeadWorkerPool(baseParams({ startedAtMs: Date.now() - 100_000, budgetMs: 60_000 }));
    pool.enqueue("lead-1");
    pool.enqueue("lead-2");
    await pool.drain();

    expect(researchLead).not.toHaveBeenCalled();
    expect(pool.summary.finished).toBe(0);
    expect(pool.summary.failed).toBe(0);
  });

  it("drain() resolves immediately when nothing was ever enqueued", async () => {
    const pool = createLeadWorkerPool(baseParams());
    await expect(pool.drain()).resolves.toBeUndefined();
    expect(researchLead).not.toHaveBeenCalled();
  });

  it("a qualified lead with a usable channel gets automatic outreach, tallied into the pool's own outreach summary", async () => {
    vi.mocked(qualifyLead).mockResolvedValue({ ok: true, qualification: { recommendedStatus: "qualified" } } as never);
    vi.mocked(sendAutomaticWhatsAppOutreach).mockResolvedValue({ attempted: true, ok: true, channel: "whatsapp", messageId: "wamid.1" } as never);

    const pool = createLeadWorkerPool(baseParams());
    pool.enqueue("lead-1");
    await pool.drain();

    expect(sendAutomaticWhatsAppOutreach).toHaveBeenCalledTimes(1);
    expect(pool.summary.outreach.whatsappSent).toBe(1);
  });
});
