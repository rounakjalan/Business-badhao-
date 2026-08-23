import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gmail/tokens", () => ({ getValidAccessToken: vi.fn() }));

import { getValidAccessToken } from "@/lib/gmail/tokens";
import { sendGmailMessage } from "@/lib/gmail/send";

const VALID_TOKEN = { ok: true as const, accessToken: "access-token-123", emailAddress: "studio@example.com" };

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

describe("sendGmailMessage", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects an invalid recipient before ever calling Gmail or checking the token", async () => {
    const result = await sendGmailMessage({ organizationId: "org-1", to: "not-an-email", subject: "Hi", body: "Hello" });
    expect(result).toEqual({ ok: false, code: "invalid_recipient", message: expect.stringContaining("not-an-email") });
    expect(getValidAccessToken).not.toHaveBeenCalled();
  });

  it("reports not_connected when no Gmail account is connected, without calling fetch", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: false, code: "not_connected", message: "No Gmail account is connected." });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "Hi", body: "Hello" });
    expect(result).toEqual({ ok: false, code: "not_connected", message: "No Gmail account is connected." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps an expired/invalid token refresh to reauth_required", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: false, code: "refresh_failed", message: "Authorization revoked." });
    const result = await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "Hi", body: "Hello" });
    expect(result).toEqual({ ok: false, code: "reauth_required", message: "Authorization revoked." });
  });

  it("returns ok:true only when Gmail's response actually contains a message id", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(VALID_TOKEN);
    mockFetchOnce(200, { id: "msg-123", threadId: "thread-456" });

    const result = await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "Hi", body: "Hello" });
    expect(result).toEqual({ ok: true, messageId: "msg-123", threadId: "thread-456", fromAddress: "studio@example.com" });
  });

  it("never returns ok:true when Gmail's 200 response is missing a message id", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(VALID_TOKEN);
    mockFetchOnce(200, {});

    const result = await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "Hi", body: "Hello" });
    expect(result.ok).toBe(false);
  });

  it("maps a Gmail 401 to reauth_required", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(VALID_TOKEN);
    mockFetchOnce(401, { error: "invalid_token" });

    const result = await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "Hi", body: "Hello" });
    expect(result).toMatchObject({ ok: false, code: "reauth_required" });
  });

  it("maps a Gmail 429 to rate_limited", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(VALID_TOKEN);
    mockFetchOnce(429, { error: "rateLimitExceeded" });

    const result = await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "Hi", body: "Hello" });
    expect(result).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("maps a Gmail 400 to invalid_recipient", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(VALID_TOKEN);
    mockFetchOnce(400, { error: { message: "Invalid To header" } });

    const result = await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "Hi", body: "Hello" });
    expect(result).toMatchObject({ ok: false, code: "invalid_recipient" });
  });

  it("treats any other non-2xx status as send_failed, never as sent", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(VALID_TOKEN);
    mockFetchOnce(500, { error: "internal" });

    const result = await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "Hi", body: "Hello" });
    expect(result).toMatchObject({ ok: false, code: "send_failed" });
  });

  it("maps a network failure to network_error rather than throwing", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(VALID_TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed: getaddrinfo ENOTFOUND gmail.googleapis.com"))
    );

    const result = await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "Hi", body: "Hello" });
    expect(result).toMatchObject({ ok: false, code: "network_error" });
  });

  it("encodes a non-ASCII subject as RFC 2047 in the raw MIME payload", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(VALID_TOKEN);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "msg-1", threadId: "t-1" }) });
    vi.stubGlobal("fetch", fetchSpy);

    await sendGmailMessage({ organizationId: "org-1", to: "lead@example.com", subject: "नमस्ते", body: "Hello" });

    const call = fetchSpy.mock.calls[0];
    const requestBody = JSON.parse(call[1].body);
    const decoded = Buffer.from(requestBody.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
  });
});
