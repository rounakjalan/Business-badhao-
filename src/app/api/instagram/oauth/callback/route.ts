import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { INSTAGRAM_SCOPES } from "@/lib/instagram/config";
import { exchangeCodeForToken, exchangeForLongLivedToken, resolveConnectedInstagramAccount } from "@/lib/instagram/oauth";
import { saveConnectedAccount } from "@/lib/instagram/tokens";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "instagram_oauth_state";

function redirectWithError(origin: string, message: string) {
  return NextResponse.redirect(`${origin}/settings?tab=Integrations&instagram=error&instagramMessage=${encodeURIComponent(message)}`);
}

export async function GET(request: Request) {
  const { origin, searchParams } = new URL(request.url);
  const cookieStore = await cookies();

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return NextResponse.redirect(`${origin}/login`);

  const metaError = searchParams.get("error");
  if (metaError) {
    return redirectWithError(origin, metaError === "access_denied" ? "Instagram connection was cancelled." : `Meta returned an error: ${metaError}`);
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectWithError(origin, "That connection link is invalid or has expired — please try connecting Instagram again.");
  }

  const shortLived = await exchangeCodeForToken(code);
  if (!shortLived.ok) {
    return redirectWithError(origin, `Could not complete the Instagram connection: ${shortLived.message}`);
  }

  const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
  if (!longLived.ok) {
    return redirectWithError(origin, `Could not complete the Instagram connection: ${longLived.message}`);
  }

  const resolved = await resolveConnectedInstagramAccount(longLived.accessToken);
  if (!resolved.ok) {
    const hint =
      resolved.code === "no_pages"
        ? "Connect a Facebook Page for your business first, then try again."
        : resolved.code === "no_linked_account"
          ? "Link an Instagram professional (Business or Creator) account to that Facebook Page in Meta Business Suite, then try again."
          : "";
    return redirectWithError(origin, `${resolved.message}${hint ? ` ${hint}` : ""}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  const saved = await saveConnectedAccount({
    organizationId: currentOrg.organizationId,
    connectedBy: user.id,
    igBusinessAccountId: resolved.account.igBusinessAccountId,
    igUsername: resolved.account.igUsername,
    facebookPageId: resolved.account.facebookPageId,
    accessToken: longLived.accessToken,
    expiresInSeconds: longLived.expiresInSeconds,
    scope: INSTAGRAM_SCOPES.join(","),
  });

  if (!saved.ok) {
    return redirectWithError(origin, "Instagram authorized successfully, but the connection could not be saved. Please try again.");
  }

  return NextResponse.redirect(`${origin}/settings?tab=Integrations&instagram=connected`);
}
