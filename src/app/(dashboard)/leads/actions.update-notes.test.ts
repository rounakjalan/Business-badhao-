import { afterEach, describe, expect, it, vi } from "vitest";

// Regression test for the audit finding: updateLeadNotes relied on RLS
// alone, with no application-level organization check — unlike every other
// write in this file. Proves the fix: the update is now explicitly scoped
// to the caller's own organization_id, and nothing is touched at all when
// there is no signed-in organization.

vi.mock("@/lib/organizations", () => ({ getCurrentOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { updateLeadNotes } from "@/app/(dashboard)/leads/actions";

const ORG = { organizationId: "org-1", organizationName: "Acme", role: "owner" as const };

function fakeSupabase() {
  const eqCalls: { column: string; value: unknown }[] = [];
  let updatePayload: unknown = null;

  const builder = {
    update(payload: unknown) {
      updatePayload = payload;
      return builder;
    },
    eq(column: string, value: unknown) {
      eqCalls.push({ column, value });
      return builder;
    },
  };

  const supabase = { from: () => builder };
  return { supabase, eqCalls, getUpdatePayload: () => updatePayload };
}

function formDataWithNotes(notes: string): FormData {
  const fd = new FormData();
  fd.set("notes", notes);
  return fd;
}

describe("updateLeadNotes", () => {
  afterEach(() => vi.clearAllMocks());

  it("scopes the update to the caller's own organization, alongside the lead id", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    const { supabase, eqCalls, getUpdatePayload } = fakeSupabase();
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    await updateLeadNotes("lead-1", formDataWithNotes("Called, left voicemail."));

    expect(eqCalls).toContainEqual({ column: "id", value: "lead-1" });
    expect(eqCalls).toContainEqual({ column: "organization_id", value: "org-1" });
    expect(getUpdatePayload()).toEqual({ notes: "Called, left voicemail." });
  });

  it("touches nothing when there is no signed-in organization", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(null);

    await updateLeadNotes("lead-1", formDataWithNotes("some notes"));

    expect(createClient).not.toHaveBeenCalled();
  });
});
