import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isInstagramOAuthConfigured } from "@/lib/instagram/config";
import { buildMetaConsentUrl } from "@/lib/instagram/oauth";
import { getCurrentOrg } from "@/lib/organizations";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "instagram_oauth_state";

export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    return NextResponse.redirect(`${origin}/login`);
  }

  if (!isInstagramOAuthConfigured()) {
    return NextResponse.redirect(
      `${origin}/settings?tab=Integrations&instagram=error&instagramMessage=${encodeURIComponent("Instagram isn't configured for this deployment yet.")}`
    );
  }

  // Standard OAuth CSRF protection: a random value set as an httpOnly
  // cookie in this response and echoed back as the `state` query param on
  // Meta's redirect — the callback only proceeds if the two match.
  const state = crypto.randomBytes(24).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return NextResponse.redirect(buildMetaConsentUrl(state));
}
