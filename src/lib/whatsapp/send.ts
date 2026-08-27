import "server-only";
import { WHATSAPP_GRAPH_API_BASE } from "@/lib/whatsapp/config";
import { normalizePhoneNumber } from "@/lib/whatsapp/phone";
import { getWhatsAppCredentials } from "@/lib/whatsapp/tokens";

export type SendWhatsAppResult =
  | { ok: true; messageId: string }
  | {
      ok: false;
      code: "not_connected" | "reauth_required" | "invalid_recipient" | "rate_limited" | "outside_window" | "send_failed" | "network_error" | "not_configured";
      message: string;
    };

type WhatsAppErrorBody = { error?: { message?: string; code?: number; error_subcode?: number } };

/**
 * WhatsApp's business rule, not this app's limitation: a free-form text
 * message can only be sent within 24 hours of the customer's last message
 * (Meta's "customer service window"); outside that window, only a
 * pre-approved message template may be sent, which this deployment does
 * not have configured. That's fine for what this app actually needs
 * WhatsApp for — continuing a conversation the lead is already in, always
 * a direct reply within that window — never cold outreach (Phase 5's real
 * first-touch is email). Meta reports this as error code 131047; mapped to
 * a distinct, honest "outside_window" rather than a generic failure.
 */
const OUTSIDE_WINDOW_ERROR_CODE = 131047;

/**
 * Sends exactly one WhatsApp text message through the organization's
 * connected number. Never returns ok:true unless Meta's API itself
 * returned a message id — every failure mode is a distinct, honestly
 * reported code, matching gmail/send.ts's contract exactly.
 */
export async function sendWhatsAppMessage(params: { organizationId: string; to: string; body: string }): Promise<SendWhatsAppResult> {
  const to = normalizePhoneNumber(params.to);
  if (to.length < 8) {
    return { ok: false, code: "invalid_recipient", message: `"${params.to}" doesn't look like a valid phone number.` };
  }

  const credentials = await getWhatsAppCredentials(params.organizationId);
  if (!credentials.ok) {
    return { ok: false, code: credentials.code, message: credentials.message };
  }

  let response: Response;
  try {
    response = await fetch(`${WHATSAPP_GRAPH_API_BASE}/${credentials.credentials.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.credentials.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: params.body } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    return { ok: false, code: "network_error", message: cause instanceof Error ? cause.message : "Network error contacting WhatsApp." };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    let parsed: WhatsAppErrorBody = {};
    try {
      parsed = JSON.parse(bodyText) as WhatsAppErrorBody;
    } catch {
      // fall through with parsed.error undefined — mapped to send_failed below
    }

    if (parsed.error?.code === OUTSIDE_WINDOW_ERROR_CODE || parsed.error?.error_subcode === OUTSIDE_WINDOW_ERROR_CODE) {
      return { ok: false, code: "outside_window", message: "This lead hasn't messaged in the last 24 hours, so WhatsApp only allows a pre-approved template message, not free text." };
    }
    if (parsed.error?.code === 190) {
      return { ok: false, code: "reauth_required", message: "WhatsApp rejected the access token. Reconnect WhatsApp in Settings." };
    }
    if (response.status === 429 || parsed.error?.code === 4 || parsed.error?.code === 80007) {
      return { ok: false, code: "rate_limited", message: `WhatsApp is rate-limiting this account right now (HTTP ${response.status}). Try again shortly.` };
    }
    if (response.status === 400 || parsed.error?.code === 100 || parsed.error?.code === 131026) {
      return { ok: false, code: "invalid_recipient", message: `WhatsApp rejected the message: ${parsed.error?.message ?? bodyText.slice(0, 300)}` };
    }
    return { ok: false, code: "send_failed", message: `WhatsApp send failed: HTTP ${response.status} ${parsed.error?.message ?? bodyText.slice(0, 300)}` };
  }

  let data: { messages?: { id?: string }[] };
  try {
    data = await response.json();
  } catch {
    return { ok: false, code: "send_failed", message: "WhatsApp's send response could not be parsed." };
  }

  const messageId = data.messages?.[0]?.id;
  if (!messageId) {
    return { ok: false, code: "send_failed", message: "WhatsApp's send response had no message id — treating as not sent." };
  }

  return { ok: true, messageId };
}
