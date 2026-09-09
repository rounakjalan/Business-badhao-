import "server-only";
import { getSiteUrl } from "@/lib/site-url";

/**
 * Instagram verification uses a real Meta app (Facebook Login for
 * Business) — there is no default or sandbox credential shipped with this
 * repo, the same way Tavily/Exa/every AI provider key and Gmail's Google
 * OAuth app aren't. Until META_APP_ID/META_APP_SECRET are set, every entry
 * point here reports "not configured" honestly rather than pretending a
 * connection succeeded.
 */
export function isInstagramOAuthConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

export function getMetaAppId(): string {
  const id = process.env.META_APP_ID;
  if (!id) throw new Error("META_APP_ID is not set.");
  return id;
}

export function getMetaAppSecret(): string {
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error("META_APP_SECRET is not set.");
  return secret;
}

export const META_GRAPH_API_VERSION = "v21.0";
export const META_GRAPH_API_BASE = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

/**
 * instagram_basic covers both reading the connected account's own profile
 * and the Business Discovery lookup of *other* professional accounts by
 * username (the only compliant way this app ever looks at another
 * account). pages_show_list/pages_read_engagement are required to resolve
 * which Facebook Page — and therefore which linked Instagram professional
 * account — the signed-in user manages; this app never posts or reads
 * content on the Page itself.
 */
export const INSTAGRAM_SCOPES = ["instagram_basic", "pages_show_list", "pages_read_engagement"];

export function getInstagramRedirectUri(): string {
  return `${getSiteUrl()}/api/instagram/oauth/callback`;
}
