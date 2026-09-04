import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { respondToConversation } from "@/lib/conversation-agent/respond";
import { getWhatsAppAppSecret, getWhatsAppWebhookVerifyToken, isWhatsAppWebhookConfigured } from "@/lib/whatsapp/config";
import { normalizePhoneNumber } from "@/lib/whatsapp/phone";
import { findOrgByPhoneNumberId } from "@/lib/whatsapp/tokens";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureConversation } from "@/lib/outreach/conversation";
import type { Json } from "@/types/database.types";

export const dynamic = "force-dynamic";

/**
 * Meta's one-time webhook verification handshake, performed once when the
 * webhook URL is registered in the Meta App dashboard (and any time the
 * subscription is re-verified). Echoes back hub.challenge only if
 * hub.verify_token matches this deployment's own configured secret.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (!isWhatsAppWebhookConfigured()) {
    return NextResponse.json({ error: "WhatsApp webhook isn't configured for this deployment yet." }, { status: 503 });
  }

  if (mode === "subscribe" && token === getWhatsAppWebhookVerifyToken() && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "verification failed" }, { status: 403 });
}

type WhatsAppMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
};

type WhatsAppWebhookPayload = {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: WhatsAppMessage[];
      };
      field?: string;
    }[];
  }[];
};

function verifySignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}

async function findLeadByPhone(admin: NonNullable<ReturnType<typeof createAdminClient>>, organizationId: string, phone: string): Promise<string | null> {
  const normalized = normalizePhoneNumber(phone);

  const { data: contacts } = await admin.from("contacts").select("lead_id, phone").eq("organization_id", organizationId).not("phone", "is", null);
  const contactMatch = (contacts ?? []).find((c) => c.phone && normalizePhoneNumber(c.phone) === normalized);
  if (contactMatch) return contactMatch.lead_id;

  const { data: prospects } = await admin.from("prospects").select("id, phone").eq("organization_id", organizationId).not("phone", "is", null);
  const prospectMatch = (prospects ?? []).find((p) => p.phone && normalizePhoneNumber(p.phone) === normalized);
  if (!prospectMatch) return null;

  const { data: lead } = await admin.from("leads").select("id").eq("organization_id", organizationId).eq("prospect_id", prospectMatch.id).maybeSingle();
  return lead?.id ?? null;
}

/**
 * Inbound WhatsApp messages. Meta subscribes exactly one callback URL per
 * Meta App (not per organization/phone number) — every organization on
 * this deployment shares this endpoint, and each payload's
 * metadata.phone_number_id is how a message gets routed to the right one
 * (see findOrgByPhoneNumberId). Always acknowledges with 200 quickly, the
 * same contract Meta documents, regardless of whether an individual
 * message could be matched/processed — a non-200 or slow response makes
 * Meta retry the whole payload, which would risk duplicate processing.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  // Fails closed, not open: an unsigned/unverifiable payload is never
  // processed, whether because it genuinely lacks a valid signature or
  // because this deployment hasn't configured WHATSAPP_APP_SECRET at all.
  // Distinguished only for operator troubleshooting (503 = misconfigured
  // deployment, 401 = a signature that didn't verify) — neither path ever
  // logs the secret or the request body, only that a request was rejected
  // and why, in general terms.
  const appSecret = getWhatsAppAppSecret();
  if (!appSecret) {
    console.error("[whatsapp webhook] rejected POST: WHATSAPP_APP_SECRET is not configured for this deployment");
    return NextResponse.json({ error: "WhatsApp webhook signature verification isn't configured for this deployment." }, { status: 503 });
  }

  const signature = request.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, signature, appSecret)) {
    console.error("[whatsapp webhook] rejected POST: missing or invalid X-Hub-Signature-256");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: true });

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      const messages = change.value?.messages ?? [];
      if (!phoneNumberId || messages.length === 0) continue;

      const account = await findOrgByPhoneNumberId(phoneNumberId);
      if (!account) continue; // No organization has connected this number — nothing to do.

      for (const message of messages) {
        const { data: existing } = await admin.from("messages").select("id").eq("organization_id", account.organizationId).eq("external_id", message.id).maybeSingle();
        if (existing) continue;

        const leadId = await findLeadByPhone(admin, account.organizationId, message.from);
        if (!leadId) continue; // Unknown sender — never fabricate a lead association.

        const conversation = await ensureConversation(admin, account.organizationId, leadId, "whatsapp");
        if (!conversation.ok) continue;

        // Only real text messages carry a body this app can act on. Other
        // WhatsApp message types (image, audio, location, ...) are stored
        // with an honest placeholder rather than an invented transcription,
        // so the thread stays complete without fabricating content.
        const body = message.type === "text" ? (message.text?.body ?? "") : `[Received a ${message.type} message — not yet supported]`;

        await admin.from("messages").insert({
          organization_id: account.organizationId,
          conversation_id: conversation.conversationId,
          lead_id: leadId,
          direction: "inbound",
          channel: "whatsapp",
          sender_type: "lead",
          body,
          from_address: message.from,
          external_id: message.id,
          metadata: { whatsappMessageType: message.type } as unknown as Json,
        });

        await admin.from("conversations").update({ last_message_at: new Date().toISOString(), status: "open" }).eq("id", conversation.conversationId);

        if (message.type === "text") {
          await respondToConversation(admin, { organizationId: account.organizationId, conversationId: conversation.conversationId, leadId });
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}
