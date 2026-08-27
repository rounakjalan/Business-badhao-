import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * All reads/writes of whatsapp_accounts go through the admin client and
 * are scoped by organization_id explicitly — RLS grants nothing on this
 * table to the `authenticated` role at all, matching email_accounts (see
 * the comment on createAdminClient and on the conversation_agent
 * migration), so the regular session-bound client could never reach it
 * even by accident.
 */

export type ConnectedWhatsAppStatus = { connected: boolean; displayPhoneNumber: string | null };

/** Safe-to-render status only — never returns the access token. */
export async function getWhatsAppConnectionStatus(organizationId: string): Promise<ConnectedWhatsAppStatus> {
  const admin = createAdminClient();
  if (!admin) return { connected: false, displayPhoneNumber: null };

  const { data } = await admin.from("whatsapp_accounts").select("display_phone_number, phone_number_id").eq("organization_id", organizationId).maybeSingle();

  return { connected: Boolean(data), displayPhoneNumber: data?.display_phone_number ?? data?.phone_number_id ?? null };
}

export async function saveWhatsAppAccount(params: {
  organizationId: string;
  connectedBy: string;
  phoneNumberId: string;
  businessAccountId: string | null;
  displayPhoneNumber: string | null;
  accessToken: string;
}): Promise<{ ok: boolean; message?: string }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, message: "Automation isn't configured in this deployment." };

  const { error } = await admin.from("whatsapp_accounts").upsert(
    {
      organization_id: params.organizationId,
      connected_by: params.connectedBy,
      phone_number_id: params.phoneNumberId,
      business_account_id: params.businessAccountId,
      display_phone_number: params.displayPhoneNumber,
      access_token: params.accessToken,
    },
    { onConflict: "organization_id" }
  );

  // 23505 here means this exact phone_number_id is already connected to a
  // *different* organization — a real conflict, not a retry, since
  // phone_number_id is globally unique (see the migration).
  if (error?.code === "23505") return { ok: false, message: "This WhatsApp number is already connected to another organization." };
  return { ok: !error, message: error?.message };
}

export async function disconnectWhatsAppAccount(organizationId: string): Promise<{ ok: boolean }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false };

  const { error } = await admin.from("whatsapp_accounts").delete().eq("organization_id", organizationId);
  return { ok: !error };
}

export type WhatsAppCredentials = { organizationId: string; phoneNumberId: string; accessToken: string };

export type WhatsAppCredentialsResult =
  | { ok: true; credentials: WhatsAppCredentials }
  | { ok: false; code: "not_connected" | "not_configured"; message: string };

/**
 * Meta's System User access tokens for WhatsApp Cloud API are permanent by
 * design (that is the point of using a System User rather than a
 * regular-user token) — unlike Gmail's hourly-expiring OAuth access token,
 * there is no refresh flow here to mirror. A revoked/rotated token simply
 * starts failing at send time (see whatsapp/send.ts's reauth_required).
 */
export async function getWhatsAppCredentials(organizationId: string): Promise<WhatsAppCredentialsResult> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, code: "not_configured", message: "Automation isn't configured in this deployment." };

  const { data } = await admin.from("whatsapp_accounts").select("phone_number_id, access_token").eq("organization_id", organizationId).maybeSingle();
  if (!data) return { ok: false, code: "not_connected", message: "No WhatsApp Business number is connected for this organization yet." };

  return { ok: true, credentials: { organizationId, phoneNumberId: data.phone_number_id, accessToken: data.access_token } };
}

/**
 * Resolves which organization an inbound webhook payload belongs to.
 * Meta's Cloud API sends every inbound message to one app-wide callback
 * URL carrying the sending phone_number_id — this is the only way the
 * webhook route can tell which organization's data to touch, and why
 * phone_number_id is a unique column (see the migration).
 */
export async function findOrgByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppCredentials | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  const { data } = await admin.from("whatsapp_accounts").select("organization_id, phone_number_id, access_token").eq("phone_number_id", phoneNumberId).maybeSingle();
  if (!data) return null;

  return { organizationId: data.organization_id, phoneNumberId: data.phone_number_id, accessToken: data.access_token };
}
