import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleConsentUrl, exchangeCodeForTokens, fetchConnectedEmailAddress, refreshAccessToken } from "@/lib/gmail/oauth";

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
  );
}

describe("gmail oauth", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.NEXT_PUBLIC_SITE_URL = "https://business-badhao.example.com";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it("builds a consent URL with the gmail.send scope, offline access, and the given state", () => {
    const url = buildGoogleConsentUrl("csrf-state-abc");
    expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth?");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain(encodeURIComponent("https://www.googleapis.com/auth/gmail.send"));
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
    expect(url).toContain("state=csrf-state-abc");
    expect(url).toContain(encodeURIComponent("https://business-badhao.example.com/api/gmail/oauth/callback"));
  });

  it("exchanges a code for tokens on success", async () => {
    mockFetchOnce(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "gmail.send" });
    const result = await exchangeCodeForTokens("auth-code-123");
    expect(result).toEqual({
      ok: true,
      tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresInSeconds: 3600, scope: "gmail.send" },
    });
  });

  it("reports a provider_error when Google rejects the code exchange", async () => {
    mockFetchOnce(400, { error: "invalid_grant" });
    const result = await exchangeCodeForTokens("bad-code");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("provider_error");
  });

  it("reports network_error rather than throwing when the token endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await exchangeCodeForTokens("auth-code-123");
    expect(result).toEqual({ ok: false, code: "network_error", message: "network down" });
  });

  it("refreshes an access token using the refresh_token grant", async () => {
    mockFetchOnce(200, { access_token: "at-2", expires_in: 3599 });
    const result = await refreshAccessToken("stored-refresh-token");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokens.accessToken).toBe("at-2");

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const sentBody = (fetchCall[1] as RequestInit).body as URLSearchParams;
    expect(sentBody.get("grant_type")).toBe("refresh_token");
    expect(sentBody.get("refresh_token")).toBe("stored-refresh-token");
  });

  it("fetches the connected account's email address from Gmail's own profile endpoint", async () => {
    mockFetchOnce(200, { emailAddress: "studio@example.com", historyId: "12345" });
    const result = await fetchConnectedEmailAddress("access-token");
    expect(result).toEqual({ ok: true, email: "studio@example.com" });

    const calledUrl = vi.mocked(fetch).mock.calls[0][0];
    expect(calledUrl).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
  });

  it("reports failure when the profile response has no email", async () => {
    mockFetchOnce(200, {});
    const result = await fetchConnectedEmailAddress("access-token");
    expect(result.ok).toBe(false);
  });
});
