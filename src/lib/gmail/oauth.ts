import "server-only";
import { getGmailRedirectUri, getGoogleClientId, getGoogleClientSecret, GMAIL_SCOPES } from "@/lib/gmail/config";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export function buildGoogleConsentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    redirect_uri: getGmailRedirectUri(),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    // Forces Google to hand back a refresh_token even on a reconnect —
    // without this, a second consent for the same Google account returns
    // no refresh_token at all, silently breaking send after the access
    // token's first expiry.
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type GoogleTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
};

export type GoogleOAuthResult = { ok: true; tokens: GoogleTokenSet } | { ok: false; code: "network_error" | "provider_error"; message: string };

async function postToken(body: URLSearchParams): Promise<GoogleOAuthResult> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    return { ok: false, code: "network_error", message: cause instanceof Error ? cause.message : "Network error contacting Google." };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return { ok: false, code: "provider_error", message: `Google token endpoint returned HTTP ${response.status}: ${bodyText.slice(0, 300)}` };
  }

  let data: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  try {
    data = await response.json();
  } catch {
    return { ok: false, code: "provider_error", message: "Google's token response could not be parsed." };
  }

  if (!data.access_token) {
    return { ok: false, code: "provider_error", message: "Google's token response had no access_token." };
  }

  return {
    ok: true,
    tokens: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresInSeconds: data.expires_in ?? 3600,
      scope: data.scope ?? "",
    },
  };
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleOAuthResult> {
  return postToken(
    new URLSearchParams({
      code,
      client_id: getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      redirect_uri: getGmailRedirectUri(),
      grant_type: "authorization_code",
    })
  );
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleOAuthResult> {
  return postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      grant_type: "refresh_token",
    })
  );
}

export type GoogleUserInfoResult = { ok: true; email: string } | { ok: false; message: string };

export async function fetchConnectedEmailAddress(accessToken: string): Promise<GoogleUserInfoResult> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : "Network error fetching the connected account's email address." };
  }

  if (!response.ok) {
    return { ok: false, message: `Google userinfo endpoint returned HTTP ${response.status}.` };
  }

  let data: { email?: string };
  try {
    data = await response.json();
  } catch {
    return { ok: false, message: "Google's userinfo response could not be parsed." };
  }

  if (!data.email) return { ok: false, message: "Google's userinfo response had no email address." };
  return { ok: true, email: data.email };
}
