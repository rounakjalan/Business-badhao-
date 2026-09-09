import "server-only";
import { META_GRAPH_API_BASE } from "@/lib/instagram/config";

/**
 * Instagram's Business Discovery field — the only compliant Graph API
 * capability for looking at another Instagram professional (Business/
 * Creator) account: a lookup by an *already-known* username, returning
 * only what that account has made public. There is no official Instagram
 * API for open-ended discovery (searching by category, location, or
 * keyword) — Business Discovery never finds a new prospect on its own; it
 * only verifies/enriches a handle the existing web/Tavily/Exa discovery
 * pipeline already found in a prospect's own website or search evidence.
 */

/** Extracts a bare username from whatever form contact-extraction/contact-search stored (a full profile URL, or already a handle). */
export function extractInstagramUsername(value: string): string | null {
  const trimmed = value.trim().replace(/^@/, "");
  if (!trimmed) return null;

  const urlMatch = /instagram\.com\/([a-zA-Z0-9_.]+)\/?/i.exec(trimmed);
  const candidate = urlMatch ? urlMatch[1] : trimmed;

  // instagram.com/p/..., /reel/..., /explore/... are post/reel/explore
  // paths, never a business's own handle — see contact-extraction.ts's own
  // identical exclusion for why these must never be treated as a username.
  if (/^(p|reel|explore|stories|tv)$/i.test(candidate)) return null;
  if (!/^[a-zA-Z0-9_.]{1,30}$/.test(candidate)) return null;

  return candidate;
}

export type InstagramBusinessProfile = {
  username: string;
  name: string | null;
  biography: string | null;
  category: string | null;
  followersCount: number | null;
  mediaCount: number | null;
  website: string | null;
  profilePictureUrl: string | null;
};

export type BusinessDiscoveryResult =
  | { ok: true; profile: InstagramBusinessProfile }
  // "not_found" is a genuine negative result (private account, not a
  // professional account, or doesn't exist) — never treated as a failure.
  | { ok: false; code: "not_found" | "rate_limited" | "provider_error" | "network_error"; message: string };

type BusinessDiscoveryResponse = {
  business_discovery?: {
    username?: string;
    name?: string;
    biography?: string;
    category?: string;
    followers_count?: number;
    media_count?: number;
    website?: string;
    profile_picture_url?: string;
  };
  error?: { message?: string; code?: number; error_subcode?: number };
};

/**
 * Looks up real, public profile data for a known Instagram username via the
 * org's own connected professional account. Never throws — every outcome is
 * a typed result so a caller (contact-enrichment.ts) can record success and
 * failure separately without either one ever aborting discovery.
 */
export async function lookupInstagramBusinessProfile(params: {
  accessToken: string;
  igBusinessAccountId: string;
  username: string;
}): Promise<BusinessDiscoveryResult> {
  const fields = `business_discovery.username(${params.username}){username,name,biography,category,followers_count,media_count,website,profile_picture_url}`;
  const url = `${META_GRAPH_API_BASE}/${params.igBusinessAccountId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(params.accessToken)}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    return { ok: false, code: "network_error", message: cause instanceof Error ? cause.message : "Network error contacting Instagram." };
  }

  const bodyText = await response.text().catch(() => "");
  let data: BusinessDiscoveryResponse;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: "provider_error", message: "Instagram's Business Discovery response could not be parsed." };
  }

  if (data.error) {
    // Meta's rate-limit signature (application-level, code 4 / 17 / 32, or
    // error_subcode 2446079 for per-account business-discovery throttling).
    if (data.error.code === 4 || data.error.code === 17 || data.error.code === 32 || data.error.error_subcode === 2446079) {
      return { ok: false, code: "rate_limited", message: data.error.message ?? "Instagram rate-limited this lookup." };
    }
    // Code 100 with no matching business_discovery is Meta's shape for
    // "not a professional account, private, or doesn't exist" — a real,
    // expected negative result, not a system failure.
    if (data.error.code === 100) {
      return { ok: false, code: "not_found", message: data.error.message ?? "No public Instagram business profile found for this username." };
    }
    return { ok: false, code: "provider_error", message: `Instagram returned HTTP ${response.status}: ${data.error.message ?? bodyText.slice(0, 300)}` };
  }

  if (!response.ok) {
    return { ok: false, code: "provider_error", message: `Instagram's Business Discovery endpoint returned HTTP ${response.status}: ${bodyText.slice(0, 300)}` };
  }

  const discovery = data.business_discovery;
  if (!discovery?.username) {
    return { ok: false, code: "not_found", message: "No public Instagram business profile found for this username." };
  }

  return {
    ok: true,
    profile: {
      username: discovery.username,
      name: discovery.name ?? null,
      biography: discovery.biography ?? null,
      category: discovery.category ?? null,
      followersCount: discovery.followers_count ?? null,
      mediaCount: discovery.media_count ?? null,
      website: discovery.website ?? null,
      profilePictureUrl: discovery.profile_picture_url ?? null,
    },
  };
}
