import "server-only";
import { WHATSAPP_GRAPH_API_BASE } from "@/lib/whatsapp/config";
import { isValidWhatsAppNumber, normalizePhoneNumber } from "@/lib/whatsapp/phone";
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

/** Shared by both send paths below — the only difference between a free-text send and a template send is this one field. */
type OutboundPayload = { messaging_product: "whatsapp"; to: string; type: "text"; text: { body: string } } | TemplatePayload;

type TemplatePayload = {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: { name: string; language: { code: string }; components?: { type: "body"; parameters: { type: "text"; text: string }[] }[] };
};

/**
 * The actual HTTP call to Meta's /messages endpoint, shared by the free-text
 * and template send paths — the request shape differs (see OutboundPayload)
 * but credential lookup, transport, and every error-mapping rule below is
 * identical for both, since Meta returns the same error shapes regardless of
 * message type.
 */
async function postToWhatsAppApi(organizationId: string, payload: OutboundPayload): Promise<SendWhatsAppResult> {
  const credentials = await getWhatsAppCredentials(organizationId);
  if (!credentials.ok) {
    return { ok: false, code: credentials.code, message: credentials.message };
  }

  let response: Response;
  try {
    response = await fetch(`${WHATSAPP_GRAPH_API_BASE}/${credentials.credentials.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.credentials.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

/**
 * Sends exactly one WhatsApp text message through the organization's
 * connected number. Never returns ok:true unless Meta's API itself
 * returned a message id — every failure mode is a distinct, honestly
 * reported code, matching gmail/send.ts's contract exactly.
 *
 * Only valid within Meta's 24-hour customer service window (see
 * OUTSIDE_WINDOW_ERROR_CODE above) — i.e. only ever a reply to a lead who
 * has messaged this business recently. For a lead who has never messaged
 * at all, use sendWhatsAppTemplateMessage instead.
 */
export async function sendWhatsAppMessage(params: { organizationId: string; to: string; body: string }): Promise<SendWhatsAppResult> {
  if (!isValidWhatsAppNumber(params.to)) {
    return { ok: false, code: "invalid_recipient", message: `"${params.to}" doesn't look like a valid phone number.` };
  }
  const to = normalizePhoneNumber(params.to);
  return postToWhatsAppApi(params.organizationId, { messaging_product: "whatsapp", to, type: "text", text: { body: params.body } });
}

/**
 * Sends a pre-approved WhatsApp message template — the only way to message a
 * lead who has never messaged this business before (see the module doc
 * comment on OUTSIDE_WINDOW_ERROR_CODE: free-form text always fails outside
 * the 24h window, which is every brand-new lead by definition). This
 * deployment has no way to create or get a template approved on an
 * organization's behalf — Meta reviews templates manually, outside this
 * codebase — so this only works once an org has entered the name of an
 * already-approved template in Settings (see whatsapp/tokens.ts).
 *
 * Supports the single most common real template shape: zero or one body
 * variable. When bodyText is given, it is sent as that template's first
 * (and only supported) {{1}} body parameter — if the org's actual approved
 * template does not have exactly one body variable in that position, Meta
 * rejects the request with a real, honest component/parameter-count error
 * (mapped to invalid_recipient/send_failed below, same as any other
 * rejection), never silently mismatched or fabricated.
 */
export async function sendWhatsAppTemplateMessage(params: {
  organizationId: string;
  to: string;
  templateName: string;
  templateLanguage: string;
  bodyText?: string;
}): Promise<SendWhatsAppResult> {
  if (!isValidWhatsAppNumber(params.to)) {
    return { ok: false, code: "invalid_recipient", message: `"${params.to}" doesn't look like a valid phone number.` };
  }
  const to = normalizePhoneNumber(params.to);
  const components = params.bodyText ? [{ type: "body" as const, parameters: [{ type: "text" as const, text: params.bodyText }] }] : undefined;
  return postToWhatsAppApi(params.organizationId, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: params.templateName, language: { code: params.templateLanguage }, components },
  });
}
