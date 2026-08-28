import { describe, expect, it } from "vitest";
import { loadBuyingIntentHistory, loadLatestIntentSnapshots } from "@/lib/intent-history";

/**
 * A minimal thenable query-builder stand-in: every chain method
 * (select/eq/in/order) returns itself, and awaiting it resolves with the
 * configured rows — matching how the real Supabase client can be chained
 * in any order but only actually executes on await.
 */
function fakeQueryBuilder(rows: unknown[]) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    then: (resolve: (v: { data: unknown[] }) => void) => resolve({ data: rows }),
  };
  return builder;
}

function fakeSupabase(rows: unknown[]) {
  return { from: () => fakeQueryBuilder(rows) } as never;
}

describe("loadBuyingIntentHistory", () => {
  it("maps each intent_detected event's category to its buying-intent bucket, in order", async () => {
    const supabase = fakeSupabase([
      { payload: { intent: "CURIOUS" }, created_at: "2026-08-20T10:00:00Z" },
      { payload: { intent: "READY_TO_BUY" }, created_at: "2026-08-21T10:00:00Z" },
    ]);

    const history = await loadBuyingIntentHistory(supabase, "conv-1", "org-1");
    expect(history).toEqual([
      { at: "2026-08-20T10:00:00Z", buyingIntent: "medium" },
      { at: "2026-08-21T10:00:00Z", buyingIntent: "high" },
    ]);
  });

  it("skips a malformed event row rather than throwing", async () => {
    const supabase = fakeSupabase([{ payload: {}, created_at: "2026-08-20T10:00:00Z" }, { payload: null, created_at: "2026-08-21T10:00:00Z" }]);
    const history = await loadBuyingIntentHistory(supabase, "conv-1", "org-1");
    expect(history).toEqual([]);
  });

  it("returns an empty history for a conversation that was never analyzed", async () => {
    const supabase = fakeSupabase([]);
    const history = await loadBuyingIntentHistory(supabase, "conv-1", "org-1");
    expect(history).toEqual([]);
  });
});

describe("loadLatestIntentSnapshots", () => {
  it("keeps only the most recent event per conversation", async () => {
    // Rows arrive newest-first, same as the real ordered query.
    const supabase = fakeSupabase([
      { conversation_id: "conv-1", payload: { intent: "READY_TO_BUY", confidence: "high" }, created_at: "2026-08-22T10:00:00Z" },
      { conversation_id: "conv-1", payload: { intent: "CURIOUS", confidence: "low" }, created_at: "2026-08-20T10:00:00Z" },
      { conversation_id: "conv-2", payload: { intent: "LOW_INTENT", confidence: "medium" }, created_at: "2026-08-21T10:00:00Z" },
    ]);

    const snapshots = await loadLatestIntentSnapshots(supabase, ["conv-1", "conv-2"], "org-1");
    expect(snapshots.get("conv-1")).toEqual({ category: "READY_TO_BUY", buyingIntent: "high", confidence: "high", at: "2026-08-22T10:00:00Z" });
    expect(snapshots.get("conv-2")).toEqual({ category: "LOW_INTENT", buyingIntent: "low", confidence: "medium", at: "2026-08-21T10:00:00Z" });
  });

  it("defaults confidence to low when the stored payload has none", async () => {
    const supabase = fakeSupabase([{ conversation_id: "conv-1", payload: { intent: "CURIOUS" }, created_at: "2026-08-20T10:00:00Z" }]);
    const snapshots = await loadLatestIntentSnapshots(supabase, ["conv-1"], "org-1");
    expect(snapshots.get("conv-1")?.confidence).toBe("low");
  });

  it("returns an empty map without querying when given no conversation ids", async () => {
    const supabase = fakeSupabase([{ conversation_id: "conv-1", payload: { intent: "CURIOUS" }, created_at: "2026-08-20T10:00:00Z" }]);
    const snapshots = await loadLatestIntentSnapshots(supabase, [], "org-1");
    expect(snapshots.size).toBe(0);
  });
});
