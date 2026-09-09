import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { exchangeForLongLivedToken } from "@/lib/instagram/oauth";

/**
 * All reads/writes of instagram_accounts go through the admin client and
 * are scoped by organization_id explicitly — RLS grants nothing on this
 * table to the `authenticated` role at all, so the regular session-bound
 * client could never reach it even by accident. Same posture as
 * email_accounts (gmail/tokens.ts).
 */

export type InstagramConnectionStatus = { connected: boolean; username: string | null };

/** Safe-to-render status only — never returns token values. */
export async function getConnectionStatus(organizationId: string): Promise<InstagramConnectionStatus> {
  const admin = createAdminClient();
  if (!admin) return { connected: false, username: null };

  const { data } = await admin.from("instagram_accounts").select("ig_username").eq("organization_id", organizationId).maybeSingle();

  return { connected: Boolean(data), username: data?.ig_username ?? null };
}

export async function saveConnectedAccount(params: {
  organizationId: string;
  connectedBy: string;
  igBusinessAccountId: string;
  igUsername: string;
  facebookPageId: string;
  accessToken: string;
  expiresInSeconds: number;
  scope: string;
}): Promise<{ ok: boolean }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false };

  const { error } = await admin.from("instagram_accounts").upsert(
    {
      organization_id: params.organizationId,
      connected_by: params.connectedBy,
      ig_business_account_id: params.igBusinessAccountId,
      ig_username: params.igUsername,
      facebook_page_id: params.facebookPageId,
      access_token: params.accessToken,
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

  const { error } = await admin.from("instagram_accounts").delete().eq("organization_id", organizationId);
  return { ok: !error };
}

export type ValidInstagramTokenResult =
  | { ok: true; accessToken: string; igBusinessAccountId: string; igUsername: string }
  | { ok: false; code: "not_connected" | "refresh_failed" | "not_configured"; message: string };

const EXPIRY_BUFFER_MS = 24 * 60 * 60 * 1000; // A day's buffer against a 60-day token — no need to cut it close.

/**
 * Returns an access token guaranteed usable for the next while, re-exchanging
 * it for a fresh long-lived one first if it's expired or getting close.
 * Meta's long-lived tokens have no separate refresh_token — the current
 * still-valid token is itself exchanged for a new 60-day one (see
 * exchangeForLongLivedToken). A refresh failure (revoked consent, deleted
 * Meta app, etc.) is reported as 'refresh_failed' rather than silently
 * treated as "connected" — callers must not attempt a lookup on a token this
 * function didn't hand back.
 */
export async function getValidAccessToken(organizationId: string): Promise<ValidInstagramTokenResult> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, code: "not_configured", message: "Automation isn't configured in this deployment." };

  const { data: account } = await admin
    .from("instagram_accounts")
    .select("access_token, token_expires_at, ig_business_account_id, ig_username")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!account) return { ok: false, code: "not_connected", message: "No Instagram account is connected for this organization yet." };

  const expiresAt = Date.parse(account.token_expires_at);
  const stillValid = Number.isFinite(expiresAt) && expiresAt - Date.now() > EXPIRY_BUFFER_MS;
  if (stillValid) {
    return { ok: true, accessToken: account.access_token, igBusinessAccountId: account.ig_business_account_id, igUsername: account.ig_username };
  }

  const refreshed = await exchangeForLongLivedToken(account.access_token);
  if (!refreshed.ok) {
    return {
      ok: false,
      code: "refresh_failed",
      message: `Instagram authorization has expired and could not be renewed (${refreshed.message}). Reconnect Instagram in Settings.`,
    };
  }

  await admin
    .from("instagram_accounts")
    .update({
      access_token: refreshed.accessToken,
      token_expires_at: new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString(),
    })
    .eq("organization_id", organizationId);

  return { ok: true, accessToken: refreshed.accessToken, igBusinessAccountId: account.ig_business_account_id, igUsername: account.ig_username };
}
