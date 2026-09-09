import "server-only";
import { getInstagramRedirectUri, getMetaAppId, getMetaAppSecret, INSTAGRAM_SCOPES, META_GRAPH_API_BASE } from "@/lib/instagram/config";

const FACEBOOK_AUTH_URL = "https://www.facebook.com/v21.0/dialog/oauth";

export function buildMetaConsentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getMetaAppId(),
    redirect_uri: getInstagramRedirectUri(),
    response_type: "code",
    scope: INSTAGRAM_SCOPES.join(","),
    state,
  });
  return `${FACEBOOK_AUTH_URL}?${params.toString()}`;
}

export type MetaOAuthResult =
  | { ok: true; accessToken: string; expiresInSeconds: number }
  | { ok: false; code: "network_error" | "provider_error"; message: string };

async function getToken(params: URLSearchParams): Promise<MetaOAuthResult> {
  let response: Response;
  try {
    response = await fetch(`${META_GRAPH_API_BASE}/oauth/access_token?${params.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    return { ok: false, code: "network_error", message: cause instanceof Error ? cause.message : "Network error contacting Meta." };
  }

  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    return { ok: false, code: "provider_error", message: `Meta's token endpoint returned HTTP ${response.status}: ${bodyText.slice(0, 300)}` };
  }

  let data: { access_token?: string; expires_in?: number };
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: "provider_error", message: "Meta's token response could not be parsed." };
  }

  if (!data.access_token) {
    return { ok: false, code: "provider_error", message: "Meta's token response had no access_token." };
  }

  return { ok: true, accessToken: data.access_token, expiresInSeconds: data.expires_in ?? 3600 };
}

/** Exchanges the authorization code for a short-lived user access token. */
export async function exchangeCodeForToken(code: string): Promise<MetaOAuthResult> {
  return getToken(
    new URLSearchParams({
      client_id: getMetaAppId(),
      client_secret: getMetaAppSecret(),
      redirect_uri: getInstagramRedirectUri(),
      code,
    })
  );
}

/**
 * Meta's short-lived user tokens expire in ~1-2 hours; exchanging for a
 * long-lived one (~60 days) is what lets a connection survive without the
 * user re-authorizing constantly. There is no refresh_token in this flow —
 * a long-lived token is itself re-exchanged for a fresh 60-day one before
 * it expires (see getValidAccessToken in tokens.ts).
 */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<MetaOAuthResult> {
  return getToken(
    new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: getMetaAppId(),
      client_secret: getMetaAppSecret(),
      fb_exchange_token: shortLivedToken,
    })
  );
}

export type ConnectedInstagramAccount = {
  facebookPageId: string;
  igBusinessAccountId: string;
  igUsername: string;
};

export type ResolveInstagramAccountResult =
  | { ok: true; account: ConnectedInstagramAccount }
  | { ok: false; code: "no_pages" | "no_linked_account" | "provider_error" | "network_error"; message: string };

type FacebookPage = { id: string; instagram_business_account?: { id: string; username: string } };

/**
 * Facebook Login for Business grants a user token scoped to the Facebook
 * Pages they manage — it never grants Instagram access directly. This
 * walks /me/accounts (the Pages the signed-in user manages) and picks the
 * first one with a linked Instagram professional account, which is what
 * Business Discovery lookups are actually made against.
 */
export async function resolveConnectedInstagramAccount(userAccessToken: string): Promise<ResolveInstagramAccountResult> {
  let response: Response;
  try {
    response = await fetch(
      `${META_GRAPH_API_BASE}/me/accounts?fields=id,instagram_business_account{id,username}&access_token=${encodeURIComponent(userAccessToken)}`,
      { signal: AbortSignal.timeout(20_000) }
    );
  } catch (cause) {
    return { ok: false, code: "network_error", message: cause instanceof Error ? cause.message : "Network error contacting Meta." };
  }

  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    return { ok: false, code: "provider_error", message: `Meta's Pages endpoint returned HTTP ${response.status}: ${bodyText.slice(0, 300)}` };
  }

  let data: { data?: FacebookPage[] };
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: "provider_error", message: "Meta's Pages response could not be parsed." };
  }

  const pages = data.data ?? [];
  if (pages.length === 0) {
    return { ok: false, code: "no_pages", message: "This Facebook account doesn't manage any Facebook Pages." };
  }

  const withInstagram = pages.find((page) => page.instagram_business_account);
  if (!withInstagram?.instagram_business_account) {
    return {
      ok: false,
      code: "no_linked_account",
      message: "None of this account's Facebook Pages have a linked Instagram professional (Business/Creator) account.",
    };
  }

  return {
    ok: true,
    account: {
      facebookPageId: withInstagram.id,
      igBusinessAccountId: withInstagram.instagram_business_account.id,
      igUsername: withInstagram.instagram_business_account.username,
    },
  };
}
