import { afterEach, describe, expect, it, vi } from "vitest";

// Regression coverage for connectInstagramWithCredentialsAction — the
// username/password "Connect Instagram" form. The one thing every test here
// must prove alongside ordinary success/failure behavior: the raw password
// never appears anywhere this function returns or redirects to (it is
// relayed to attemptSandboxCredentialLogin and nowhere else) — see that
// function's own doc comment for the full chain of custody.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/organizations", () => ({ getCurrentOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/instagram-discovery/connection", () => ({
  requestInstagramDiscoveryConnection: vi.fn(),
}));
vi.mock("@/lib/instagram-discovery/sandbox-runtime", () => ({
  attemptSandboxCredentialLogin: vi.fn(),
  wakeHermesSandboxRuntime: vi.fn(),
}));

import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { requestInstagramDiscoveryConnection } from "@/lib/instagram-discovery/connection";
import { attemptSandboxCredentialLogin } from "@/lib/instagram-discovery/sandbox-runtime";
import { connectInstagramWithCredentialsAction } from "@/app/(dashboard)/settings/actions";

const ORG = { organizationId: "org-1", organizationName: "Acme", role: "owner" as const };
const PASSWORD = "correct-horse-battery-staple";

function fakeSupabaseWithUser(userId: string | null) {
  return { auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) } };
}

function redirectTarget(): string {
  const call = vi.mocked(redirect).mock.calls[0]?.[0];
  return String(call ?? "");
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("connectInstagramWithCredentialsAction", () => {
  afterEach(() => vi.clearAllMocks());

  it("redirects with an error and never calls the runtime when the password is missing", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseWithUser("user-1") as never);

    await expect(connectInstagramWithCredentialsAction(formData({ instagramUsername: "biz_official", instagramPassword: "" }))).rejects.toThrow(
      "REDIRECT:"
    );

    expect(attemptSandboxCredentialLogin).not.toHaveBeenCalled();
    expect(requestInstagramDiscoveryConnection).not.toHaveBeenCalled();
    expect(redirectTarget()).toContain("instagramDiscovery=error");
  });

  it("relays the exact username/password to the runtime, scoped to the caller's own organization", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseWithUser("user-1") as never);
    vi.mocked(requestInstagramDiscoveryConnection).mockResolvedValue({ ok: true });
    vi.mocked(attemptSandboxCredentialLogin).mockResolvedValue({ ok: true, username: "biz_official" });

    await expect(
      connectInstagramWithCredentialsAction(formData({ instagramUsername: "biz_official", instagramPassword: PASSWORD }))
    ).rejects.toThrow("REDIRECT:");

    expect(requestInstagramDiscoveryConnection).toHaveBeenCalledWith("org-1", "user-1");
    expect(attemptSandboxCredentialLogin).toHaveBeenCalledWith("org-1", "biz_official", PASSWORD);
  });

  it("redirects to a success state with the connected username on a genuine login", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseWithUser("user-1") as never);
    vi.mocked(requestInstagramDiscoveryConnection).mockResolvedValue({ ok: true });
    vi.mocked(attemptSandboxCredentialLogin).mockResolvedValue({ ok: true, username: "biz_official" });

    await expect(
      connectInstagramWithCredentialsAction(formData({ instagramUsername: "biz_official", instagramPassword: PASSWORD }))
    ).rejects.toThrow("REDIRECT:");

    const target = decodeURIComponent(redirectTarget());
    expect(target).toContain("instagramDiscovery=tested");
    expect(target).toContain("@biz_official");
  });

  it("passes through the runtime's own real failure reason rather than fabricating success", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseWithUser("user-1") as never);
    vi.mocked(requestInstagramDiscoveryConnection).mockResolvedValue({ ok: true });
    vi.mocked(attemptSandboxCredentialLogin).mockResolvedValue({ ok: false, message: "Sorry, your password was incorrect." });

    await expect(
      connectInstagramWithCredentialsAction(formData({ instagramUsername: "biz_official", instagramPassword: "wrong-password" }))
    ).rejects.toThrow("REDIRECT:");

    const target = decodeURIComponent(redirectTarget());
    expect(target).toContain("instagramDiscovery=error");
    expect(target).toContain("password was incorrect");
  });

  it("never includes the raw password in the redirect URL, on success or failure", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseWithUser("user-1") as never);
    vi.mocked(requestInstagramDiscoveryConnection).mockResolvedValue({ ok: true });

    vi.mocked(attemptSandboxCredentialLogin).mockResolvedValue({ ok: true, username: "biz_official" });
    await expect(
      connectInstagramWithCredentialsAction(formData({ instagramUsername: "biz_official", instagramPassword: PASSWORD }))
    ).rejects.toThrow("REDIRECT:");
    expect(redirectTarget()).not.toContain(PASSWORD);

    vi.clearAllMocks();
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseWithUser("user-1") as never);
    vi.mocked(requestInstagramDiscoveryConnection).mockResolvedValue({ ok: true });
    vi.mocked(attemptSandboxCredentialLogin).mockResolvedValue({ ok: false, message: "Invalid credentials." });
    await expect(
      connectInstagramWithCredentialsAction(formData({ instagramUsername: "biz_official", instagramPassword: PASSWORD }))
    ).rejects.toThrow("REDIRECT:");
    expect(redirectTarget()).not.toContain(PASSWORD);
  });

  it("redirects to login when there is no signed-in organization, without touching the runtime", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(null);

    await expect(
      connectInstagramWithCredentialsAction(formData({ instagramUsername: "biz_official", instagramPassword: PASSWORD }))
    ).rejects.toThrow("REDIRECT:/login");

    expect(attemptSandboxCredentialLogin).not.toHaveBeenCalled();
  });
});
