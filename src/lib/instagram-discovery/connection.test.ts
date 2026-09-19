import { afterEach, describe, expect, it, vi } from "vitest";

// Mirrors the fake-admin-client convention used elsewhere in this codebase
// (discovery-batch.test.ts, whatsapp/webhook/route.test.ts) — a small,
// in-memory stand-in for the service-role Supabase client, since this
// module's actual contract (organization isolation, real state transitions)
// is what needs proving, not the Supabase SDK itself.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  applyInstagramDiscoveryRuntimeReport,
  disconnectInstagramDiscoveryConnection,
  getInstagramDiscoveryConnectionStatus,
  getUsableInstagramDiscoveryProfileRef,
  isInstagramDiscoveryRuntimeConfigured,
  requestInstagramDiscoveryConnection,
} from "@/lib/instagram-discovery/connection";

type Row = Record<string, unknown>;

function makeFakeAdmin(initialRows: Row[] = []) {
  let rows = [...initialRows];

  const from = () => ({
    select: () => ({
      eq: (_col: string, value: unknown) => ({
        maybeSingle: async () => ({ data: rows.find((r) => r.organization_id === value) ?? null, error: null }),
      }),
    }),
    upsert: async (values: Row) => {
      rows = rows.filter((r) => r.organization_id !== values.organization_id);
      rows.push({ id: `conn-${rows.length + 1}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...values });
      return { error: null };
    },
    update: (values: Row) => ({
      eq: (_col: string, value: unknown) => ({
        select: () => ({
          maybeSingle: async () => {
            const existing = rows.find((r) => r.organization_id === value);
            if (!existing) return { data: null, error: null };
            Object.assign(existing, values);
            return { data: { id: existing.id }, error: null };
          },
        }),
      }),
    }),
    delete: () => ({
      eq: async (_col: string, value: unknown) => {
        rows = rows.filter((r) => r.organization_id !== value);
        return { error: null };
      },
    }),
  });

  return { from, __rows: () => rows } as unknown as ReturnType<typeof createAdminClient> & { __rows: () => Row[] };
}

const ORIGINAL_ENV = { ...process.env };

describe("isInstagramDiscoveryRuntimeConfigured", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is false when no runtime token is set", () => {
    delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
    expect(isInstagramDiscoveryRuntimeConfigured()).toBe(false);
  });

  it("is true when a runtime token is set — a deployment-level fact, independent of any one organization's own connection", () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "test-token";
    expect(isInstagramDiscoveryRuntimeConfigured()).toBe(true);
  });
});

describe("getInstagramDiscoveryConnectionStatus", () => {
  afterEach(() => vi.resetAllMocks());

  it("reports not_connected when no row exists for the organization", async () => {
    vi.mocked(createAdminClient).mockReturnValue(makeFakeAdmin([]));
    const status = await getInstagramDiscoveryConnectionStatus("org-1");
    expect(status).toEqual({ status: "not_connected", connectedUsername: null, lastError: null, requestedAt: null, lastVerifiedAt: null });
  });

  it("never returns another organization's connection — tenant isolation", async () => {
    const admin = makeFakeAdmin([
      { organization_id: "org-1", status: "connected", connected_username: "org1_business", last_error: null, requested_at: "2026-01-01T00:00:00Z", last_verified_at: "2026-01-02T00:00:00Z" },
      { organization_id: "org-2", status: "error", connected_username: null, last_error: "org-2's own failure", requested_at: "2026-01-01T00:00:00Z", last_verified_at: null },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const org1Status = await getInstagramDiscoveryConnectionStatus("org-1");
    const org2Status = await getInstagramDiscoveryConnectionStatus("org-2");

    expect(org1Status.status).toBe("connected");
    expect(org1Status.connectedUsername).toBe("org1_business");
    expect(org2Status.status).toBe("error");
    expect(org2Status.lastError).toBe("org-2's own failure");
    // Org 1 never sees org 2's error, and vice versa.
    expect(org1Status.lastError).toBeNull();
    expect(org2Status.connectedUsername).toBeNull();
  });

  it("never exposes browser_profile_ref or any credential-shaped field", async () => {
    const admin = makeFakeAdmin([{ organization_id: "org-1", status: "connected", connected_username: "biz", browser_profile_ref: "profile-abc-123", last_error: null, requested_at: null, last_verified_at: null }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const status = await getInstagramDiscoveryConnectionStatus("org-1");
    expect(Object.keys(status)).not.toContain("browser_profile_ref");
    expect(Object.keys(status)).not.toContain("password");
    expect(Object.keys(status)).not.toContain("cookie");
    expect(Object.keys(status)).not.toContain("session_token");
    expect(Object.keys(status)).not.toContain("access_token");
  });
});

describe("requestInstagramDiscoveryConnection", () => {
  afterEach(() => vi.resetAllMocks());

  it("creates a connection scoped to the requesting organization only", async () => {
    const admin = makeFakeAdmin([]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await requestInstagramDiscoveryConnection("org-1", "user-1");

    expect(result.ok).toBe(true);
    const rows = admin.__rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organization_id: "org-1", requested_by: "user-1", status: "authentication_required" });
  });

  it("never touches another organization's existing connection", async () => {
    const admin = makeFakeAdmin([{ organization_id: "org-2", status: "connected", connected_username: "org2_business" }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    await requestInstagramDiscoveryConnection("org-1", "user-1");

    const org2Row = admin.__rows().find((r) => r.organization_id === "org-2");
    expect(org2Row).toMatchObject({ status: "connected", connected_username: "org2_business" });
  });

  it("clears any stale profile reference/error from a previous, abandoned attempt when re-requested", async () => {
    const admin = makeFakeAdmin([{ organization_id: "org-1", status: "error", last_error: "a previous failure", browser_profile_ref: "stale-ref" }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    await requestInstagramDiscoveryConnection("org-1", "user-1");

    const row = admin.__rows()[0];
    expect(row.status).toBe("authentication_required");
    expect(row.last_error).toBeNull();
    expect(row.browser_profile_ref).toBeNull();
  });

  it("never records an Instagram password anywhere — no such field exists in the write payload", async () => {
    const admin = makeFakeAdmin([]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    await requestInstagramDiscoveryConnection("org-1", "user-1");

    const row = admin.__rows()[0];
    expect(Object.keys(row)).not.toContain("password");
    expect(Object.keys(row)).not.toContain("instagram_password");
    expect(Object.keys(row)).not.toContain("cookie");
  });
});

describe("disconnectInstagramDiscoveryConnection", () => {
  afterEach(() => vi.resetAllMocks());

  it("removes only the specified organization's connection", async () => {
    const admin = makeFakeAdmin([
      { organization_id: "org-1", status: "connected" },
      { organization_id: "org-2", status: "connected" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await disconnectInstagramDiscoveryConnection("org-1");

    expect(result.ok).toBe(true);
    const remaining = admin.__rows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].organization_id).toBe("org-2");
  });

  it("disconnecting revokes the usable connection state — status reads back as not_connected afterward", async () => {
    const admin = makeFakeAdmin([{ organization_id: "org-1", status: "connected", connected_username: "biz" }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    await disconnectInstagramDiscoveryConnection("org-1");
    const status = await getInstagramDiscoveryConnectionStatus("org-1");

    expect(status.status).toBe("not_connected");
  });
});

describe("applyInstagramDiscoveryRuntimeReport", () => {
  afterEach(() => vi.resetAllMocks());

  it("updates only the reported organization's connection", async () => {
    const admin = makeFakeAdmin([
      { organization_id: "org-1", status: "authentication_required" },
      { organization_id: "org-2", status: "authentication_required" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await applyInstagramDiscoveryRuntimeReport({ organizationId: "org-1", status: "connected", username: "org1_business", profileRef: "profile-xyz" });

    expect(result.ok).toBe(true);
    const org1 = admin.__rows().find((r) => r.organization_id === "org-1");
    const org2 = admin.__rows().find((r) => r.organization_id === "org-2");
    expect(org1).toMatchObject({ status: "connected", connected_username: "org1_business" });
    expect(org2).toMatchObject({ status: "authentication_required" });
  });

  it("rejects a report for an organization that never requested a connection — never silently creates one", async () => {
    const admin = makeFakeAdmin([]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await applyInstagramDiscoveryRuntimeReport({ organizationId: "org-never-requested", status: "connected", username: "someone" });

    expect(result).toEqual({ ok: false, code: "no_pending_connection", message: expect.any(String) });
    expect(admin.__rows()).toHaveLength(0);
  });

  it("records a real, honest error report without fabricating a successful connection", async () => {
    const admin = makeFakeAdmin([{ organization_id: "org-1", status: "authentication_required" }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await applyInstagramDiscoveryRuntimeReport({ organizationId: "org-1", status: "error", error: "Instagram presented a login challenge the runtime could not complete" });

    expect(result.ok).toBe(true);
    const row = admin.__rows()[0];
    expect(row.status).toBe("error");
    expect(row.last_error).toBe("Instagram presented a login challenge the runtime could not complete");
    expect(row.connected_username).toBeNull();
  });

  it("accepts the runtime's 'ready' state (an already-authenticated profile, not a fresh login) and stamps last_verified_at", async () => {
    const admin = makeFakeAdmin([{ organization_id: "org-1", status: "connected", connected_username: "biz_official" }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await applyInstagramDiscoveryRuntimeReport({ organizationId: "org-1", status: "ready", username: "biz_official", profileRef: "org-1" });

    expect(result.ok).toBe(true);
    const row = admin.__rows()[0];
    expect(row.status).toBe("ready");
    expect(row.last_verified_at).toBeTruthy();
  });

  it("records a real runtime infrastructure failure ('browser_unavailable') distinctly from an Instagram-side error", async () => {
    const admin = makeFakeAdmin([{ organization_id: "org-1", status: "connected" }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const result = await applyInstagramDiscoveryRuntimeReport({ organizationId: "org-1", status: "browser_unavailable", error: "Chromium binary crashed on launch" });

    expect(result.ok).toBe(true);
    expect(admin.__rows()[0]).toMatchObject({ status: "browser_unavailable", last_error: "Chromium binary crashed on launch" });
  });
});

describe("getUsableInstagramDiscoveryProfileRef", () => {
  afterEach(() => vi.resetAllMocks());

  it("returns the real profile ref for a connection that is actually usable ('connected' or 'ready')", async () => {
    const admin = makeFakeAdmin([
      { organization_id: "org-1", status: "connected", browser_profile_ref: "org-1" },
      { organization_id: "org-2", status: "ready", browser_profile_ref: "org-2" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    expect(await getUsableInstagramDiscoveryProfileRef("org-1")).toBe("org-1");
    expect(await getUsableInstagramDiscoveryProfileRef("org-2")).toBe("org-2");
  });

  it("returns null for a connection that exists but isn't currently usable — never dispatches a job against a dead session", async () => {
    const admin = makeFakeAdmin([{ organization_id: "org-1", status: "session_expired", browser_profile_ref: "org-1" }]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    expect(await getUsableInstagramDiscoveryProfileRef("org-1")).toBeNull();
  });

  it("returns null for an organization with no connection at all", async () => {
    vi.mocked(createAdminClient).mockReturnValue(makeFakeAdmin([]));
    expect(await getUsableInstagramDiscoveryProfileRef("org-1")).toBeNull();
  });

  it("never returns another organization's profile ref", async () => {
    const admin = makeFakeAdmin([
      { organization_id: "org-1", status: "connected", browser_profile_ref: "org-1-ref" },
      { organization_id: "org-2", status: "connected", browser_profile_ref: "org-2-ref" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin);

    expect(await getUsableInstagramDiscoveryProfileRef("org-1")).toBe("org-1-ref");
    expect(await getUsableInstagramDiscoveryProfileRef("org-2")).toBe("org-2-ref");
  });
});
