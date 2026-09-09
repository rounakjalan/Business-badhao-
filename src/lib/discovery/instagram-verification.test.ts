import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instagram/tokens", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("@/lib/instagram/business-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram/business-discovery")>();
  return { ...actual, lookupInstagramBusinessProfile: vi.fn() };
});

import { lookupInstagramBusinessProfile } from "@/lib/instagram/business-discovery";
import { getValidAccessToken } from "@/lib/instagram/tokens";
import { verifyInstagramProfile } from "@/lib/discovery/instagram-verification";

const CONNECTED = { ok: true as const, accessToken: "tok", igBusinessAccountId: "1789", igUsername: "myshop" };

describe("verifyInstagramProfile", () => {
  afterEach(() => vi.clearAllMocks());

  it("skips verification entirely when there's no usable handle — never attempted, never a failure", async () => {
    const result = await verifyInstagramProfile("org-1", "not a real url");
    expect(result).toEqual({ attempted: false, reason: "no_handle" });
    expect(getValidAccessToken).not.toHaveBeenCalled();
  });

  it("skips verification when the org hasn't connected Instagram — 'not_connected', never a failure", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: false, code: "not_connected", message: "No Instagram account is connected." });

    const result = await verifyInstagramProfile("org-1", "https://instagram.com/myshop");
    expect(result).toEqual({ attempted: false, reason: "not_connected" });
    expect(lookupInstagramBusinessProfile).not.toHaveBeenCalled();
  });

  it("treats 'not_configured' (the feature itself isn't set up in this deployment) the same as not_connected — never a false failure", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: false, code: "not_configured", message: "Automation isn't configured." });

    const result = await verifyInstagramProfile("org-1", "https://instagram.com/myshop");
    expect(result).toEqual({ attempted: false, reason: "not_connected" });
  });

  it("reports a genuinely broken connection (refresh_failed) as a real, attempted failure — distinct from simply not being connected", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: false, code: "refresh_failed", message: "Instagram authorization has expired." });

    const result = await verifyInstagramProfile("org-1", "https://instagram.com/myshop");
    expect(result).toEqual({ attempted: true, ok: false, code: "provider_error", message: "Instagram authorization has expired." });
  });

  it("verifies a real profile when connected and the lookup succeeds", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(CONNECTED);
    vi.mocked(lookupInstagramBusinessProfile).mockResolvedValue({
      ok: true,
      profile: {
        username: "brightpixel",
        name: "Bright Pixel Studio",
        biography: null,
        category: "Design agency",
        followersCount: 4200,
        mediaCount: 310,
        website: null,
        profilePictureUrl: null,
      },
    });

    const result = await verifyInstagramProfile("org-1", "https://instagram.com/brightpixel/");

    expect(result).toEqual({
      attempted: true,
      ok: true,
      profile: expect.objectContaining({ username: "brightpixel", followersCount: 4200 }),
    });
    expect(lookupInstagramBusinessProfile).toHaveBeenCalledWith({ accessToken: "tok", igBusinessAccountId: "1789", username: "brightpixel" });
  });

  it("passes through a rate-limited or not-found lookup result honestly, as an attempted failure — isolated, never thrown", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(CONNECTED);
    vi.mocked(lookupInstagramBusinessProfile).mockResolvedValue({ ok: false, code: "rate_limited", message: "Application request limit reached" });

    const result = await verifyInstagramProfile("org-1", "https://instagram.com/brightpixel");
    expect(result).toEqual({ attempted: true, ok: false, code: "rate_limited", message: "Application request limit reached" });
  });
});
