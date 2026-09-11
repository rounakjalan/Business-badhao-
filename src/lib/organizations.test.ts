import { afterEach, describe, expect, it, vi } from "vitest";

// STEP 8 audit: current organization resolution (getCurrentOrg) always
// resolves to the signed-in user's OLDEST organization_members row. The
// audit could not tell from the code alone whether this is intentional
// single-organization MVP behavior or a missing multi-org switcher.
//
// Conclusion reached (see this fix's own report for the full evidence):
// intentional MVP limitation, not a bug. Onboarding (src/app/onboarding/
// page.tsx) redirects straight to /dashboard the moment a user has ANY
// membership, so there is no product-reachable path to create a second
// organization once a user has one; Settings' "+ Invite Member" button is
// `disabled title="Coming soon"`, so there is also no path to be added to
// a second organization; and no org-switcher UI, cookie, or route exists
// anywhere in the codebase. This file is the regression test the audit
// asked for: it locks down the CURRENT resolution behavior (oldest
// membership wins) so it cannot change silently, and proves the
// isolation/authorization properties the audit required regardless of the
// decision (a user's own membership only, never another user's; the
// correct organization row for that exact membership; no leakage between
// independent calls).
//
// Note on `cache()`: getCurrentUser/getCurrentOrg are wrapped in React's
// `cache()`, which memoizes within a single request in the real Next.js
// runtime (and Next.js gives every incoming request its own fresh cache
// scope, which is what actually prevents one request's resolution from
// leaking into another's — that guarantee lives in the framework, not in
// this file). Verified empirically that `cache()` is a no-op outside an
// active React render (as in this test file): each call below runs the
// real function body fresh against whatever the mocked client returns at
// that moment. That makes this the right level to prove the resolver
// itself carries no hidden state of its own that could defeat the
// framework's per-request guarantee — the "different mock, different
// call, correct independent result" tests below do exactly that.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/organizations";

type Membership = { user_id: string; organization_id: string; role: string; created_at: string };

function fakeSupabase({
  user,
  memberships = [],
  organizations = {},
}: {
  user: { id: string } | null;
  memberships?: Membership[];
  organizations?: Record<string, string>;
}) {
  return {
    auth: {
      getUser: async () => ({ data: { user } }),
    },
    from(table: string) {
      if (table === "organization_members") {
        const filters: ((r: Membership) => boolean)[] = [];
        let ascending = true;
        let limitN: number | null = null;
        const api = {
          select: () => api,
          eq: (col: string, val: unknown) => {
            filters.push((r: Membership) => (r as unknown as Record<string, unknown>)[col] === val);
            return api;
          },
          order: (_col: string, opts?: { ascending?: boolean }) => {
            ascending = opts?.ascending ?? true;
            return api;
          },
          limit: (n: number) => {
            limitN = n;
            return api;
          },
          maybeSingle: async () => {
            let rows = memberships.filter((r) => filters.every((f) => f(r)));
            rows = [...rows].sort((a, b) => (ascending ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));
            if (limitN !== null) rows = rows.slice(0, limitN);
            return { data: rows[0] ?? null };
          },
        };
        return api;
      }
      if (table === "organizations") {
        let targetId: string | null = null;
        const api = {
          select: () => api,
          eq: (_col: string, val: string) => {
            targetId = val;
            return api;
          },
          maybeSingle: async () => ({ data: targetId && organizations[targetId] ? { name: organizations[targetId] } : null }),
        };
        return api;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

describe("getCurrentUser", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the signed-in user", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase({ user: { id: "user-1" } }) as never);
    expect(await getCurrentUser()).toEqual({ id: "user-1" });
  });

  it("returns null when no one is signed in", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase({ user: null }) as never);
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("getCurrentOrg — current single-organization resolution (intentional MVP behavior)", () => {
  afterEach(() => vi.clearAllMocks());

  it("resolves the user's one organization, with its real name and role", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        user: { id: "user-1" },
        memberships: [{ user_id: "user-1", organization_id: "org-1", role: "owner", created_at: "2026-01-01T00:00:00Z" }],
        organizations: { "org-1": "Acme Inc" },
      }) as never
    );

    expect(await getCurrentOrg()).toEqual({ organizationId: "org-1", organizationName: "Acme Inc", role: "owner" });
  });

  it("with multiple memberships, resolves the OLDEST one by created_at — not array order, not the newest", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        user: { id: "user-1" },
        // Deliberately scrambled order and a middle-dated row listed first,
        // so passing this actually exercises the ORDER BY, not array order.
        memberships: [
          { user_id: "user-1", organization_id: "org-newest", role: "member", created_at: "2026-03-01T00:00:00Z" },
          { user_id: "user-1", organization_id: "org-oldest", role: "owner", created_at: "2026-01-01T00:00:00Z" },
          { user_id: "user-1", organization_id: "org-middle", role: "admin", created_at: "2026-02-01T00:00:00Z" },
        ],
        organizations: { "org-oldest": "First Org", "org-middle": "Second Org", "org-newest": "Third Org" },
      }) as never
    );

    expect(await getCurrentOrg()).toEqual({ organizationId: "org-oldest", organizationName: "First Org", role: "owner" });
  });

  it("returns null for a signed-in user with zero memberships, rather than defaulting to any organization", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase({ user: { id: "user-1" }, memberships: [] }) as never);
    expect(await getCurrentOrg()).toBeNull();
  });

  it("returns null and never queries organization_members when no one is signed in", async () => {
    const supabase = fakeSupabase({ user: null });
    const fromSpy = vi.spyOn(supabase, "from");
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    expect(await getCurrentOrg()).toBeNull();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("falls back to an empty organization name (never throws) if the organizations row can't be found", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        user: { id: "user-1" },
        memberships: [{ user_id: "user-1", organization_id: "org-1", role: "owner", created_at: "2026-01-01T00:00:00Z" }],
        organizations: {},
      }) as never
    );

    expect(await getCurrentOrg()).toEqual({ organizationId: "org-1", organizationName: "", role: "owner" });
  });
});

describe("getCurrentOrg — membership authorization and organization isolation", () => {
  afterEach(() => vi.clearAllMocks());

  it("never resolves another user's membership, even when it is older and present in the same table", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        user: { id: "user-2" },
        memberships: [
          // Belongs to a different user, and is older — if the user_id
          // filter were ever dropped or broken, this row would win instead.
          { user_id: "user-1", organization_id: "org-other-user", role: "owner", created_at: "2020-01-01T00:00:00Z" },
          { user_id: "user-2", organization_id: "org-2", role: "member", created_at: "2026-01-01T00:00:00Z" },
        ],
        organizations: { "org-other-user": "Not Mine", "org-2": "Mine" },
      }) as never
    );

    expect(await getCurrentOrg()).toEqual({ organizationId: "org-2", organizationName: "Mine", role: "member" });
  });

  it("looks up the organization row for the exact membership's organization_id, never a different organization present in the same table", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        user: { id: "user-1" },
        memberships: [{ user_id: "user-1", organization_id: "org-correct", role: "owner", created_at: "2026-01-01T00:00:00Z" }],
        organizations: { "org-correct": "Correct Org", "org-wrong": "Wrong Org" },
      }) as never
    );

    const result = await getCurrentOrg();
    expect(result?.organizationName).toBe("Correct Org");
  });

  it("independent calls never leak one resolved organization into another — a second call against a different mocked user/org returns that call's own organization, not a stale result from the first", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        user: { id: "user-1" },
        memberships: [{ user_id: "user-1", organization_id: "org-1", role: "owner", created_at: "2026-01-01T00:00:00Z" }],
        organizations: { "org-1": "First Caller's Org" },
      }) as never
    );
    const first = await getCurrentOrg();

    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        user: { id: "user-2" },
        memberships: [{ user_id: "user-2", organization_id: "org-2", role: "member", created_at: "2026-01-01T00:00:00Z" }],
        organizations: { "org-2": "Second Caller's Org" },
      }) as never
    );
    const second = await getCurrentOrg();

    expect(first).toEqual({ organizationId: "org-1", organizationName: "First Caller's Org", role: "owner" });
    expect(second).toEqual({ organizationId: "org-2", organizationName: "Second Caller's Org", role: "member" });
  });
});
