import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp/tokens", () => ({ getWhatsAppCredentials: vi.fn() }));

import { getWhatsAppCredentials } from "@/lib/whatsapp/tokens";
import { sendWhatsAppMessage } from "@/lib/whatsapp/send";

const VALID_CREDENTIALS = { ok: true as const, credentials: { organizationId: "org-1", phoneNumberId: "1234567890", accessToken: "wa-access-token" } };

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

describe("sendWhatsAppMessage", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects a recipient with too few digits before ever checking credentials", async () => {
    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "12345", body: "Hi" });
    expect(result).toEqual({ ok: false, code: "invalid_recipient", message: expect.stringContaining("12345") });
    expect(getWhatsAppCredentials).not.toHaveBeenCalled();
  });

  it("normalizes a formatted phone number (spaces, dashes, +) before sending", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.1" }] }) });
    vi.stubGlobal("fetch", fetchSpy);

    await sendWhatsAppMessage({ organizationId: "org-1", to: "+91 98765-43210", body: "Hi" });

    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.to).toBe("919876543210");
  });

  it("reports not_connected when no WhatsApp number is connected, without calling fetch", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue({ ok: false, code: "not_connected", message: "No WhatsApp Business number is connected." });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "919876543210", body: "Hi" });
    expect(result).toEqual({ ok: false, code: "not_connected", message: "No WhatsApp Business number is connected." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns ok:true only when WhatsApp's response actually contains a message id", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    mockFetchOnce(200, { messages: [{ id: "wamid.HBg" }] });

    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "919876543210", body: "Hi" });
    expect(result).toEqual({ ok: true, messageId: "wamid.HBg" });
  });

  it("never returns ok:true when the 200 response is missing a message id", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    mockFetchOnce(200, { messages: [] });

    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "919876543210", body: "Hi" });
    expect(result.ok).toBe(false);
  });

  it("maps error code 190 (invalid/expired token) to reauth_required", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    mockFetchOnce(401, { error: { message: "Error validating access token", code: 190 } });

    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "919876543210", body: "Hi" });
    expect(result).toMatchObject({ ok: false, code: "reauth_required" });
  });

  it("maps the 24-hour customer service window error (131047) to a distinct outside_window code, not a generic failure", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    mockFetchOnce(400, { error: { message: "Re-engagement message", code: 131047 } });

    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "919876543210", body: "Hi" });
    expect(result).toMatchObject({ ok: false, code: "outside_window" });
  });

  it("maps a rate-limit error to rate_limited", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    mockFetchOnce(429, { error: { message: "Too many requests", code: 4 } });

    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "919876543210", body: "Hi" });
    expect(result).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("maps an invalid-parameter error to invalid_recipient", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    mockFetchOnce(400, { error: { message: "Invalid parameter", code: 100 } });

    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "919876543210", body: "Hi" });
    expect(result).toMatchObject({ ok: false, code: "invalid_recipient" });
  });

  it("treats any other non-2xx status as send_failed, never as sent", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    mockFetchOnce(500, { error: { message: "Internal error", code: 1 } });

    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "919876543210", body: "Hi" });
    expect(result).toMatchObject({ ok: false, code: "send_failed" });
  });

  it("maps a network failure to network_error rather than throwing", async () => {
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed: getaddrinfo ENOTFOUND graph.facebook.com")));

    const result = await sendWhatsAppMessage({ organizationId: "org-1", to: "919876543210", body: "Hi" });
    expect(result).toMatchObject({ ok: false, code: "network_error" });
  });
});
