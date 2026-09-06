import { isValidWhatsAppNumber } from "@/lib/whatsapp/phone";

/**
 * Deterministic, pure channel-selection rule for automatic outbound
 * outreach — no DB access, no side effects, so it can be tested in
 * isolation from every input that actually determines it.
 *
 * WhatsApp is preferred (matching what this feature actually asked for —
 * WhatsApp as the automatic channel) whenever it can genuinely be used:
 * connected, an approved cold-outreach template configured (Meta requires
 * one for any first message — see whatsapp/send.ts), a valid phone on the
 * lead, and not turned off for this specific campaign. Anything else
 * "falls through" to Gmail only as a *reporting* outcome — this never
 * triggers an automatic Gmail send, since cold email in this app has always
 * been a human-reviewed, manually-sent action (generateLeadOutreachAction /
 * sendLeadOutreachAction) and building automatic cold email was not part of
 * what changed here; gmail_manual only tells a human that email is the
 * available fallback for this lead.
 */
export type WhatsAppIneligibleReason = "campaign_disabled" | "not_connected" | "template_not_configured" | "invalid_or_missing_phone";

export type OutreachChannelDecision =
  | { channel: "whatsapp" }
  | { channel: "gmail_manual"; whatsappIneligibleReason: WhatsAppIneligibleReason }
  | { channel: "none"; whatsappIneligibleReason: WhatsAppIneligibleReason };

export function selectOutreachChannel(input: {
  whatsappEnabledForCampaign: boolean;
  whatsappConnected: boolean;
  whatsappTemplateConfigured: boolean;
  phone: string | null;
  gmailConnected: boolean;
}): OutreachChannelDecision {
  const whatsappIneligibleReason: WhatsAppIneligibleReason | null = !input.whatsappEnabledForCampaign
    ? "campaign_disabled"
    : !input.whatsappConnected
      ? "not_connected"
      : !input.whatsappTemplateConfigured
        ? "template_not_configured"
        : !isValidWhatsAppNumber(input.phone)
          ? "invalid_or_missing_phone"
          : null;

  if (!whatsappIneligibleReason) return { channel: "whatsapp" };
  return input.gmailConnected ? { channel: "gmail_manual", whatsappIneligibleReason } : { channel: "none", whatsappIneligibleReason };
}
