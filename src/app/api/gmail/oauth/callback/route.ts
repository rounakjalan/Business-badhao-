import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeCodeForTokens, fetchConnectedEmailAddress } from "@/lib/gmail/oauth";
import { saveConnectedAccount } from "@/lib/gmail/tokens";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "gmail_oauth_state";

function redirectWithError(origin: string, message: string) {
  return NextResponse.redirect(`${origin}/settings?tab=Integrations&gmail=error&gmailMessage=${encodeURIComponent(message)}`);
}

export async function GET(request: Request) {
  const { origin, searchParams } = new URL(request.url);
  const cookieStore = await cookies();

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return NextResponse.redirect(`${origin}/login`);

  const googleError = searchParams.get("error");
  if (googleError) {
    return redirectWithError(origin, googleError === "access_denied" ? "Gmail connection was cancelled." : `Google returned an error: ${googleError}`);
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectWithError(origin, "That connection link is invalid or has expired — please try connecting Gmail again.");
  }

  const tokenResult = await exchangeCodeForTokens(code);
  if (!tokenResult.ok) {
    return redirectWithError(origin, `Could not complete the Gmail connection: ${tokenResult.message}`);
  }

  if (!tokenResult.tokens.refreshToken) {
    return redirectWithError(
      origin,
      "Google didn't return a long-lived authorization. If you've connected this Google account before, revoke Business Badhao's access at https://myaccount.google.com/permissions and try connecting again."
    );
  }

  const emailResult = await fetchConnectedEmailAddress(tokenResult.tokens.accessToken);
  if (!emailResult.ok) {
    return redirectWithError(origin, `Connected, but could not read the account's email address: ${emailResult.message}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  const saved = await saveConnectedAccount({
    organizationId: currentOrg.organizationId,
    connectedBy: user.id,
    emailAddress: emailResult.email,
    accessToken: tokenResult.tokens.accessToken,
    refreshToken: tokenResult.tokens.refreshToken,
    expiresInSeconds: tokenResult.tokens.expiresInSeconds,
    scope: tokenResult.tokens.scope,
  });

  if (!saved.ok) {
    return redirectWithError(origin, "Gmail authorized successfully, but the connection could not be saved. Please try again.");
  }

  return NextResponse.redirect(`${origin}/settings?tab=Integrations&gmail=connected`);
}
