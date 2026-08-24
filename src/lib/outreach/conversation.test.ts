import { describe, expect, it } from "vitest";
import { ensureConversation } from "@/lib/outreach/conversation";

type Response = { data: unknown; error?: { code?: string; message?: string } | null };

/**
 * A minimal stand-in for the Supabase query builder: every chain method
 * (select/eq/order/limit) returns the same object so any call sequence
 * chains fine, and each table has its own queue of canned responses
 * consumed in call order by whichever terminal method (maybeSingle/single)
 * is actually invoked — matching how ensureConversation really calls it.
 */
function makeClient(queues: { conversations?: Response[]; leads?: Response[] }) {
  const tableQueues: Record<string, Response[]> = {
    conversations: [...(queues.conversations ?? [])],
    leads: [...(queues.leads ?? [])],
  };
  const inserted: { table: string; values: Record<string, unknown> }[] = [];

  function chain(table: string) {
    const next = () => tableQueues[table]?.shift() ?? { data: null };
    const obj = {
      select: () => obj,
      eq: () => obj,
      order: () => obj,
      limit: () => obj,
      maybeSingle: async () => next(),
      single: async () => next(),
      insert: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return obj;
      },
    };
    return obj;
  }

  const supabase = { from: (table: string) => chain(table) } as unknown as Parameters<typeof ensureConversation>[0];
  return { supabase, inserted };
}

describe("ensureConversation", () => {
  it("returns the existing conversation without inserting one", async () => {
    const { supabase, inserted } = makeClient({ conversations: [{ data: { id: "conv-existing" } }] });

    const result = await ensureConversation(supabase, "org-1", "lead-1", "email");

    expect(result).toEqual({ ok: true, conversationId: "conv-existing" });
    expect(inserted).toHaveLength(0);
  });

  it("creates a new conversation, inheriting the lead's campaign, when none exists yet", async () => {
    const { supabase, inserted } = makeClient({
      conversations: [{ data: null }, { data: { id: "conv-new" } }],
      leads: [{ data: { campaign_id: "camp-1" } }],
    });

    const result = await ensureConversation(supabase, "org-1", "lead-1", "email");

    expect(result).toEqual({ ok: true, conversationId: "conv-new" });
    expect(inserted).toEqual([{ table: "conversations", values: expect.objectContaining({ campaign_id: "camp-1", channel: "email" }) }]);
  });

  it("falls back to the winning row on a unique-index collision instead of failing the send", async () => {
    const { supabase } = makeClient({
      conversations: [{ data: null }, { data: null, error: { code: "23505" } }, { data: { id: "conv-winner" } }],
      leads: [{ data: { campaign_id: null } }],
    });

    const result = await ensureConversation(supabase, "org-1", "lead-1", "email");

    expect(result).toEqual({ ok: true, conversationId: "conv-winner" });
  });

  it("reports failure for a non-collision insert error", async () => {
    const { supabase } = makeClient({
      conversations: [{ data: null }, { data: null, error: { code: "23503", message: "insert or update on table violates foreign key constraint" } }],
      leads: [{ data: null }],
    });

    const result = await ensureConversation(supabase, "org-1", "lead-1", "email");

    expect(result).toEqual({ ok: false, message: "insert or update on table violates foreign key constraint" });
  });

  it("reports failure, not a fabricated conversation id, if a 23505 collision's re-select somehow finds nothing", async () => {
    const { supabase } = makeClient({
      conversations: [{ data: null }, { data: null, error: { code: "23505" } }, { data: null }],
      leads: [{ data: null }],
    });

    const result = await ensureConversation(supabase, "org-1", "lead-1", "email");

    expect(result).toEqual({ ok: false, message: "Could not create a conversation for this lead." });
  });
});
