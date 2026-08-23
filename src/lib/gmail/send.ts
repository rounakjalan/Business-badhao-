import "server-only";
import { getValidAccessToken } from "@/lib/gmail/tokens";

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SendGmailResult =
  | { ok: true; messageId: string; threadId: string; fromAddress: string }
  | {
      ok: false;
      code: "not_connected" | "reauth_required" | "invalid_recipient" | "rate_limited" | "send_failed" | "network_error" | "not_configured";
      message: string;
    };

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function encodeHeaderValue(value: string): string {
  if (isPrintableAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function buildRawMessage(params: { to: string; from: string; subject: string; body: string }): string {
  const bodyBase64 = Buffer.from(params.body, "utf-8").toString("base64");
  const mime = [
    `To: ${params.to}`,
    `From: ${params.from}`,
    `Subject: ${encodeHeaderValue(params.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    bodyBase64,
  ].join("\r\n");

  return base64UrlEncode(mime);
}

/**
 * Sends exactly one email through the organization's connected Gmail
 * account. Never returns ok:true unless Gmail's API itself returned a
 * message id — every failure mode (missing recipient, expired auth, rate
 * limit, network error, any other Gmail-side rejection) is a distinct,
 * honestly-reported code, never silently treated as sent.
 */
export async function sendGmailMessage(params: { organizationId: string; to: string; subject: string; body: string }): Promise<SendGmailResult> {
  if (!EMAIL_PATTERN.test(params.to)) {
    return { ok: false, code: "invalid_recipient", message: `"${params.to}" doesn't look like a valid email address.` };
  }

  const token = await getValidAccessToken(params.organizationId);
  if (!token.ok) {
    if (token.code === "not_connected") return { ok: false, code: "not_connected", message: token.message };
    if (token.code === "not_configured") return { ok: false, code: "not_configured", message: token.message };
    return { ok: false, code: "reauth_required", message: token.message };
  }

  const raw = buildRawMessage({ to: params.to, from: token.emailAddress, subject: params.subject, body: params.body });

  let response: Response;
  try {
    response = await fetch(GMAIL_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    return { ok: false, code: "network_error", message: cause instanceof Error ? cause.message : "Network error contacting Gmail." };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    if (response.status === 401) {
      return { ok: false, code: "reauth_required", message: "Gmail rejected the access token. Reconnect Gmail in Settings." };
    }
    if (response.status === 429 || response.status === 403) {
      return { ok: false, code: "rate_limited", message: `Gmail is rate-limiting this account right now (HTTP ${response.status}). Try again shortly.` };
    }
    if (response.status === 400) {
      return { ok: false, code: "invalid_recipient", message: `Gmail rejected the message: ${bodyText.slice(0, 300)}` };
    }
    return { ok: false, code: "send_failed", message: `Gmail send failed: HTTP ${response.status} ${bodyText.slice(0, 300)}` };
  }

  let data: { id?: string; threadId?: string };
  try {
    data = await response.json();
  } catch {
    return { ok: false, code: "send_failed", message: "Gmail's send response could not be parsed." };
  }

  if (!data.id || !data.threadId) {
    return { ok: false, code: "send_failed", message: "Gmail's send response had no message id — treating as not sent." };
  }

  return { ok: true, messageId: data.id, threadId: data.threadId, fromAddress: token.emailAddress };
}
