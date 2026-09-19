import { afterEach, describe, expect, it, vi } from "vitest";

// This file tests only testInstagramDiscoveryConnectionAction — matching
// this codebase's existing convention of a focused test for one new
// Server Action rather than wholesale coverage of settings/actions.ts (see
// deals/actions.quick-task.test.ts). redirect() really throws in Next.js
// (it never returns), so the mock below throws too — see
// auth/actions.password-reset.test.ts for the same pattern.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/organizations", () => ({ getCurrentOrg: vi.fn() }));
vi.mock("@/lib/instagram-discovery/connection", () => ({
  getInstagramDiscoveryConnectionStatus: vi.fn(),
  isInstagramDiscoveryRuntimeConfigured: vi.fn(),
}));
vi.mock("@/lib/instagram-discovery/jobs", () => ({
  createInstagramDiscoveryVerificationJob: vi.fn(),
  pollInstagramDiscoveryJobResult: vi.fn(),
}));

import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/organizations";
import { getInstagramDiscoveryConnectionStatus, isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";
import { createInstagramDiscoveryVerificationJob, pollInstagramDiscoveryJobResult } from "@/lib/instagram-discovery/jobs";
import { testInstagramDiscoveryConnectionAction } from "@/app/(dashboard)/settings/actions";

const ORG = { organizationId: "org-1", organizationName: "Acme", role: "owner" as const };

function redirectTarget(): string {
  const call = vi.mocked(redirect).mock.calls[0]?.[0];
  return String(call ?? "");
}

describe("testInstagramDiscoveryConnectionAction", () => {
  afterEach(() => vi.clearAllMocks());

  it("redirects honestly when no runtime is configured, without creating a job", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(false);

    await expect(testInstagramDiscoveryConnectionAction()).rejects.toThrow("REDIRECT:");

    expect(createInstagramDiscoveryVerificationJob).not.toHaveBeenCalled();
    expect(redirectTarget()).toContain("instagramDiscovery=error");
  });

  it("scopes the verification job to the caller's own organization", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(createInstagramDiscoveryVerificationJob).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(pollInstagramDiscoveryJobResult).mockResolvedValue({ ok: true, candidates: [] });
    vi.mocked(getInstagramDiscoveryConnectionStatus).mockResolvedValue({
      status: "ready",
      connectedUsername: "biz_official",
      lastError: null,
      requestedAt: null,
      lastVerifiedAt: null,
    });

    await expect(testInstagramDiscoveryConnectionAction()).rejects.toThrow("REDIRECT:");

    expect(createInstagramDiscoveryVerificationJob).toHaveBeenCalledWith("org-1");
    expect(getInstagramDiscoveryConnectionStatus).toHaveBeenCalledWith("org-1");
  });

  it("reports a real verified session honestly, including the connected username", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(createInstagramDiscoveryVerificationJob).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(pollInstagramDiscoveryJobResult).mockResolvedValue({ ok: true, candidates: [] });
    vi.mocked(getInstagramDiscoveryConnectionStatus).mockResolvedValue({
      status: "connected",
      connectedUsername: "biz_official",
      lastError: null,
      requestedAt: null,
      lastVerifiedAt: null,
    });

    await expect(testInstagramDiscoveryConnectionAction()).rejects.toThrow("REDIRECT:");

    const target = redirectTarget();
    expect(target).toContain("instagramDiscovery=tested");
    expect(decodeURIComponent(target)).toContain("@biz_official");
  });

  it("reports the runtime's own real failure reason rather than a generic success", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(createInstagramDiscoveryVerificationJob).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(pollInstagramDiscoveryJobResult).mockResolvedValue({ ok: true, candidates: [] });
    vi.mocked(getInstagramDiscoveryConnectionStatus).mockResolvedValue({
      status: "session_expired",
      connectedUsername: null,
      lastError: "The saved Instagram session is no longer authenticated.",
      requestedAt: null,
      lastVerifiedAt: null,
    });

    await expect(testInstagramDiscoveryConnectionAction()).rejects.toThrow("REDIRECT:");

    const target = decodeURIComponent(redirectTarget());
    expect(target).toContain("instagramDiscovery=tested");
    expect(target).toContain("no longer authenticated");
  });

  it("reports honestly when the runtime never answers within the timeout — never fabricates success", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(createInstagramDiscoveryVerificationJob).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(pollInstagramDiscoveryJobResult).mockResolvedValue({ ok: false, message: "The Instagram discovery runtime did not respond within the allotted time." });

    await expect(testInstagramDiscoveryConnectionAction()).rejects.toThrow("REDIRECT:");

    expect(getInstagramDiscoveryConnectionStatus).not.toHaveBeenCalled();
    expect(redirectTarget()).toContain("instagramDiscovery=error");
  });

  it("redirects with an error when the job can't even be created", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(createInstagramDiscoveryVerificationJob).mockResolvedValue(null);

    await expect(testInstagramDiscoveryConnectionAction()).rejects.toThrow("REDIRECT:");

    expect(pollInstagramDiscoveryJobResult).not.toHaveBeenCalled();
    expect(redirectTarget()).toContain("instagramDiscovery=error");
  });
});
