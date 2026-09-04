import "server-only";

/**
 * WhatsApp Cloud API (Meta) integration. Unlike Gmail — where each
 * organization authorizes its own account through an OAuth consent screen
 * — WhatsApp Business Cloud API's simplest integration path is a
 * permanent System User access token issued directly from Meta Business
 * Manager, with no user-facing OAuth redirect. An org admin obtains a
 * phone_number_id and access_token from their own Meta Business account
 * and enters them directly in Settings > Integrations (see
 * src/lib/whatsapp/tokens.ts) — there is no "Connect" flow to build here.
 *
 * What IS shared across every organization on this deployment is the
 * webhook: Meta subscribes exactly one callback URL per Meta App, so these
 * two values are configured once, app-wide, in this deployment's own
 * environment — never per-organization, and never invented if unset.
 */

/** Whether this deployment can receive/verify WhatsApp webhooks at all. */
export function isWhatsAppWebhookConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
}

export function getWhatsAppWebhookVerifyToken(): string {
  const token = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!token) throw new Error("WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set.");
  return token;
}

/**
 * Required for the webhook to accept any inbound payload: verifies
 * X-Hub-Signature-256 so an attacker who learns/guesses an organization's
 * public phone_number_id cannot forge inbound messages (which would
 * otherwise create real conversations, spend a real AI reply, and send a
 * real WhatsApp message to a real customer). Deliberately fails closed —
 * unlike a feature that's simply unset and absent, an unsigned inbound
 * payload is an active spoofing/cost-abuse surface, not a missing
 * capability, so it is never processed as if verification had passed.
 */
export function getWhatsAppAppSecret(): string | null {
  return process.env.WHATSAPP_APP_SECRET?.trim() || null;
}

export const WHATSAPP_GRAPH_API_VERSION = "v20.0";
export const WHATSAPP_GRAPH_API_BASE = `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}`;
