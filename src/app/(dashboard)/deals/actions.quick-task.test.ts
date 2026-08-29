import { afterEach, describe, expect, it, vi } from "vitest";

// This file tests only quickCreateTaskForDeal — the one function added to
// close the "deal-task writer" gap found in the cross-tab data-sharing
// audit. It deliberately does not attempt to cover the rest of
// deals/actions.ts, matching this codebase's existing convention of not
// unit-testing thin server-action wrappers wholesale; this one function
// gets a focused test because it's new integration behavior worth locking
// down: which table it writes to, what it links the task to, and that it
// never writes anything when the deal isn't the caller's to touch.

vi.mock("@/lib/organizations", () => ({ getCurrentOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { quickCreateTaskForDeal } from "@/app/(dashboard)/deals/actions";

const ORG = { organizationId: "org-1", organizationName: "Acme", role: "owner" as const };

function fakeSupabase({ deal, insertError = null }: { deal: { id: string } | null; insertError?: { message: string } | null }) {
  const insertedRows: unknown[] = [];

  const dealsBuilder = {
    select: () => dealsBuilder,
    eq: () => dealsBuilder,
    maybeSingle: async () => ({ data: deal }),
  };

  const tasksBuilder = {
    insert: (row: unknown) => {
      insertedRows.push(row);
      return Promise.resolve({ error: insertError });
    },
  };

  const supabase = {
    from(table: string) {
      if (table === "deals") return dealsBuilder;
      if (table === "tasks") return tasksBuilder;
      throw new Error(`unexpected table: ${table}`);
    },
  };

  return { supabase, insertedRows };
}

describe("quickCreateTaskForDeal", () => {
  afterEach(() => vi.clearAllMocks());

  it("writes a task linked to the deal via related_entity_type/related_entity_id, scoped to the caller's organization", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    const { supabase, insertedRows } = fakeSupabase({ deal: { id: "deal-1" } });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const result = await quickCreateTaskForDeal("deal-1", "Website Redesign — Acme");

    expect(result).toEqual({ ok: true });
    expect(insertedRows).toEqual([
      {
        organization_id: "org-1",
        title: "Follow up on Website Redesign — Acme",
        related_entity_type: "deal",
        related_entity_id: "deal-1",
      },
    ]);
  });

  it("refuses and writes nothing when the deal doesn't belong to the caller's organization", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    const { supabase, insertedRows } = fakeSupabase({ deal: null });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const result = await quickCreateTaskForDeal("deal-from-another-org", "Someone else's deal");

    expect(result.ok).toBe(false);
    expect(insertedRows).toEqual([]);
  });

  it("refuses and never touches the database when there is no signed-in organization", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(null);

    const result = await quickCreateTaskForDeal("deal-1", "Acme Deal");

    expect(result.ok).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("surfaces the database error instead of silently reporting success", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    const { supabase } = fakeSupabase({ deal: { id: "deal-1" }, insertError: { message: "insert failed" } });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const result = await quickCreateTaskForDeal("deal-1", "Acme Deal");

    expect(result).toEqual({ ok: false, message: "insert failed" });
  });
});
