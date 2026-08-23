import "server-only";
import { getSiteUrl } from "@/lib/site-url";

/**
 * Gmail send/reply uses a real Google OAuth app — there is no default or
 * sandbox credential shipped with this repo, the same way Tavily/Exa/every
 * AI provider key isn't. Until GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are
 * set, every entry point here reports "not configured" honestly rather
 * than pretending a connection succeeded.
 */
export function isGmailOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function getGoogleClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_CLIENT_ID is not set.");
  return id;
}

export function getGoogleClientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not set.");
  return secret;
}

/** Scope needed to send mail as the connected account. Read/list access is
 * also requested so the same connection can poll for replies (see
 * src/lib/gmail/replies.ts) without a second, separate consent step. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];

export function getGmailRedirectUri(): string {
  return `${getSiteUrl()}/api/gmail/oauth/callback`;
}
