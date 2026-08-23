import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshAccessToken } from "@/lib/gmail/oauth";

/**
 * All reads/writes of email_accounts go through the admin client and are
 * scoped by organization_id explicitly (see the comment on createAdminClient
 * and on the email_accounts migration) — RLS grants nothing on this table
 * to the `authenticated` role at all, so the regular session-bound client
 * could never reach it even by accident.
 */

export type ConnectedAccountStatus = { connected: boolean; emailAddress: string | null };

/** Safe-to-render status only — never returns token values. */
export async function getConnectionStatus(organizationId: string): Promise<ConnectedAccountStatus> {
  const admin = createAdminClient();
  if (!admin) return { connected: false, emailAddress: null };

  const { data } = await admin.from("email_accounts").select("email_address").eq("organization_id", organizationId).maybeSingle();

  return { connected: Boolean(data), emailAddress: data?.email_address ?? null };
}

export async function saveConnectedAccount(params: {
  organizationId: string;
  connectedBy: string;
  emailAddress: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
}): Promise<{ ok: boolean }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false };

  const { error } = await admin.from("email_accounts").upsert(
    {
      organization_id: params.organizationId,
      connected_by: params.connectedBy,
      email_address: params.emailAddress,
      access_token: params.accessToken,
      refresh_token: params.refreshToken,
      token_expires_at: new Date(Date.now() + params.expiresInSeconds * 1000).toISOString(),
      scope: params.scope,
    },
    { onConflict: "organization_id" }
  );

  return { ok: !error };
}

export async function disconnectAccount(organizationId: string): Promise<{ ok: boolean }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false };

  const { error } = await admin.from("email_accounts").delete().eq("organization_id", organizationId);
  return { ok: !error };
}

export type ValidAccessTokenResult =
  | { ok: true; accessToken: string; emailAddress: string }
  | { ok: false; code: "not_connected" | "refresh_failed" | "not_configured"; message: string };

const EXPIRY_BUFFER_MS = 2 * 60 * 1000;

/**
 * Returns an access token guaranteed usable for the next few minutes,
 * refreshing it first if it's expired or close to it. A refresh failure
 * (revoked consent, deleted Google app, etc.) is reported as
 * 'refresh_failed' rather than silently treated as "connected" — callers
 * must not attempt to send on a token this function didn't hand back.
 */
export async function getValidAccessToken(organizationId: string): Promise<ValidAccessTokenResult> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, code: "not_configured", message: "Automation isn't configured in this deployment." };

  const { data: account } = await admin
    .from("email_accounts")
    .select("access_token, refresh_token, token_expires_at, email_address")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!account) return { ok: false, code: "not_connected", message: "No Gmail account is connected for this organization yet." };

  const expiresAt = Date.parse(account.token_expires_at);
  const stillValid = Number.isFinite(expiresAt) && expiresAt - Date.now() > EXPIRY_BUFFER_MS;
  if (stillValid) {
    return { ok: true, accessToken: account.access_token, emailAddress: account.email_address };
  }

  const refreshed = await refreshAccessToken(account.refresh_token);
  if (!refreshed.ok) {
    return {
      ok: false,
      code: "refresh_failed",
      message: `Gmail authorization has expired and could not be renewed (${refreshed.message}). Reconnect Gmail in Settings.`,
    };
  }

  await admin
    .from("email_accounts")
    .update({
      access_token: refreshed.tokens.accessToken,
      token_expires_at: new Date(Date.now() + refreshed.tokens.expiresInSeconds * 1000).toISOString(),
      // Google only returns a new refresh_token occasionally; keep the
      // existing one when it doesn't.
      ...(refreshed.tokens.refreshToken ? { refresh_token: refreshed.tokens.refreshToken } : {}),
    })
    .eq("organization_id", organizationId);

  return { ok: true, accessToken: refreshed.tokens.accessToken, emailAddress: account.email_address };
}

export async function getLastHistoryId(organizationId: string): Promise<string | null> {
  const admin = createAdminClient();
  if (!admin) return null;
  const { data } = await admin.from("email_accounts").select("last_history_id").eq("organization_id", organizationId).maybeSingle();
  return data?.last_history_id ?? null;
}

export async function setLastHistoryId(organizationId: string, historyId: string): Promise<void> {
  const admin = createAdminClient();
  if (!admin) return;
  await admin.from("email_accounts").update({ last_history_id: historyId }).eq("organization_id", organizationId);
}
