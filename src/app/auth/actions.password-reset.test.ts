import { afterEach, describe, expect, it, vi } from "vitest";

// STEP 9 audit fix: Business Badhao had email/password auth but no real
// forgot-password / reset-password flow. These tests cover the two new
// Server Actions added to src/app/auth/actions.ts:
//
// - requestPasswordReset: must never reveal whether an email exists
//   (anti-enumeration) — the redirect target is identical whether Supabase
//   reports success, a "no such user" outcome, or any other error.
// - updatePassword: must validate the new password server-side (defense in
//   depth against a bypassed client-side minLength/required), and must
//   distinguish "no active recovery session" (invalid/expired link) from a
//   genuine Supabase update error, without ever touching this app's own
//   database for password storage.
//
// redirect() really throws in Next.js (it never returns), so the mock below
// throws too — any assertion that code "never runs after a redirect" is
// therefore exercised the same way the real runtime enforces it.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/site-url", () => ({ getSiteUrl: vi.fn(() => "https://business-badhao.vercel.app") }));

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requestPasswordReset, updatePassword } from "@/app/auth/actions";

function redirectTarget(): string {
  const call = vi.mocked(redirect).mock.calls[0]?.[0];
  return String(call ?? "");
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("requestPasswordReset — anti-enumeration", () => {
  afterEach(() => vi.clearAllMocks());

  it("redirects to the same generic 'check your email' state when the email exists and Supabase succeeds", async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({ auth: { resetPasswordForEmail } } as never);

    await expect(requestPasswordReset(formData({ email: "real@example.com" }))).rejects.toThrow("REDIRECT:");

    expect(redirectTarget()).toBe("/forgot-password?message=check-email");
  });

  it("redirects to the exact same generic state when Supabase reports an error (e.g. the email does not exist)", async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: { message: "User not found" } });
    vi.mocked(createClient).mockResolvedValue({ auth: { resetPasswordForEmail } } as never);

    await expect(requestPasswordReset(formData({ email: "unknown@example.com" }))).rejects.toThrow("REDIRECT:");

    expect(redirectTarget()).toBe("/forgot-password?message=check-email");
  });

  it("still calls Supabase's resetPasswordForEmail with the submitted email for a genuine account", async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({ auth: { resetPasswordForEmail } } as never);

    await expect(requestPasswordReset(formData({ email: "real@example.com" }))).rejects.toThrow("REDIRECT:");

    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      "real@example.com",
      expect.objectContaining({ redirectTo: expect.any(String) })
    );
  });

  it("builds the redirect URL from getSiteUrl(), reusing the existing generic /auth/callback route with ?next=/reset-password", async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({ auth: { resetPasswordForEmail } } as never);

    await expect(requestPasswordReset(formData({ email: "real@example.com" }))).rejects.toThrow("REDIRECT:");

    const [, options] = resetPasswordForEmail.mock.calls[0];
    expect(options.redirectTo).toBe("https://business-badhao.vercel.app/auth/callback?next=/reset-password");
  });

  it("never produces a localhost reset URL when getSiteUrl() resolves to the deployed production domain", async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({ auth: { resetPasswordForEmail } } as never);

    await expect(requestPasswordReset(formData({ email: "real@example.com" }))).rejects.toThrow("REDIRECT:");

    const [, options] = resetPasswordForEmail.mock.calls[0];
    expect(options.redirectTo).not.toContain("localhost");
  });

  it("rejects a blank email before ever calling Supabase, with a plain validation message (not an enumeration signal)", async () => {
    await expect(requestPasswordReset(formData({ email: "   " }))).rejects.toThrow("REDIRECT:");

    expect(createClient).not.toHaveBeenCalled();
    expect(redirectTarget()).toBe("/forgot-password?error=Please%20enter%20your%20email%20address.");
  });
});

describe("updatePassword — password validation", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejects a password/confirmation mismatch without touching Supabase", async () => {
    await expect(updatePassword(formData({ password: "abcdef", confirmPassword: "ghijkl" }))).rejects.toThrow(
      "REDIRECT:"
    );

    expect(createClient).not.toHaveBeenCalled();
    expect(redirectTarget()).toMatch(/^\/reset-password\?error=/);
    expect(decodeURIComponent(redirectTarget())).toContain("do not match");
  });

  it("rejects a too-short password without touching Supabase", async () => {
    await expect(updatePassword(formData({ password: "ab", confirmPassword: "ab" }))).rejects.toThrow("REDIRECT:");

    expect(createClient).not.toHaveBeenCalled();
    expect(decodeURIComponent(redirectTarget())).toContain("at least");
  });
});

describe("updatePassword — invalid/expired recovery session handling", () => {
  afterEach(() => vi.clearAllMocks());

  it("redirects with an expired-link error, and never calls updateUser, when there is no authenticated recovery session", async () => {
    const updateUser = vi.fn();
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }), updateUser },
    } as never);

    await expect(updatePassword(formData({ password: "abcdef", confirmPassword: "abcdef" }))).rejects.toThrow(
      "REDIRECT:"
    );

    expect(updateUser).not.toHaveBeenCalled();
    expect(decodeURIComponent(redirectTarget())).toContain("invalid or has expired");
  });
});

describe("updatePassword — successful update flow", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls Supabase's updateUser with the new password, signs out the recovery session, and redirects to login with a success message", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    const signOut = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
        updateUser,
        signOut,
      },
    } as never);

    await expect(updatePassword(formData({ password: "newpass1", confirmPassword: "newpass1" }))).rejects.toThrow(
      "REDIRECT:"
    );

    expect(updateUser).toHaveBeenCalledWith({ password: "newpass1" });
    expect(signOut).toHaveBeenCalled();
    expect(redirectTarget()).toBe("/login?message=password-updated");
  });

  it("redirects back to reset-password with Supabase's own error, and does not sign out, when updateUser fails", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: { message: "Password is too weak" } });
    const signOut = vi.fn();
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
        updateUser,
        signOut,
      },
    } as never);

    await expect(updatePassword(formData({ password: "newpass1", confirmPassword: "newpass1" }))).rejects.toThrow(
      "REDIRECT:"
    );

    expect(signOut).not.toHaveBeenCalled();
    expect(redirectTarget()).toBe("/reset-password?error=Password%20is%20too%20weak");
  });
});
