import "server-only";
import { extractInstagramUsername, lookupInstagramBusinessProfile, type InstagramBusinessProfile } from "@/lib/instagram/business-discovery";
import { getValidAccessToken } from "@/lib/instagram/tokens";

/**
 * Verifies a prospect's already-discovered Instagram handle — found by
 * contact-extraction.ts (the business's own website) or contact-search.ts
 * (Tavily/Exa fallback), never by Instagram itself — against the org's own
 * connected Instagram professional account, via the compliant Business
 * Discovery lookup (src/lib/instagram/business-discovery.ts). This never
 * searches Instagram and never discovers a prospect on its own; it only
 * confirms/enriches a handle the existing pipeline already found.
 *
 * `attempted: false` covers every case where nothing was actually asked of
 * Instagram — no handle to check, or the org hasn't connected an account —
 * so a run with Instagram unconfigured looks identical to one that simply
 * never needed it, never a false failure.
 */
export type InstagramVerificationOutcome =
  | { attempted: false; reason: "no_handle" | "not_connected" }
  | { attempted: true; ok: true; profile: InstagramBusinessProfile }
  | { attempted: true; ok: false; code: "not_found" | "rate_limited" | "provider_error" | "network_error"; message: string };

/**
 * Never throws: every outcome is a typed, isolated result so a caller
 * (contact-enrichment.ts) can record success and failure separately without
 * either one ever aborting discovery — see discovery-batch.ts's own
 * try/catch around the whole contact-discovery step, which this rides
 * inside of.
 */
export async function verifyInstagramProfile(organizationId: string, instagramUrlOrHandle: string): Promise<InstagramVerificationOutcome> {
  const username = extractInstagramUsername(instagramUrlOrHandle);
  if (!username) return { attempted: false, reason: "no_handle" };

  const token = await getValidAccessToken(organizationId);
  if (!token.ok) {
    // "not_connected"/"not_configured" both mean there is nothing to verify
    // against — not a failure, exactly like NullDiscoveryProvider's own
    // honest "not configured" for the primary search source. Only a
    // genuinely broken connection (a token that was there and stopped
    // working) is a real, reportable failure.
    if (token.code === "refresh_failed") {
      return { attempted: true, ok: false, code: "provider_error", message: token.message };
    }
    return { attempted: false, reason: "not_connected" };
  }

  const result = await lookupInstagramBusinessProfile({
    accessToken: token.accessToken,
    igBusinessAccountId: token.igBusinessAccountId,
    username,
  });

  if (!result.ok) return { attempted: true, ok: false, code: result.code, message: result.message };
  return { attempted: true, ok: true, profile: result.profile };
}
