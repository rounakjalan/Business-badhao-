import "server-only";
import type { ProviderTelemetry } from "@/lib/ai/agents/discovery";
import {
  emptyContacts,
  extractContactsFromHtml,
  extractLinks,
  hasAnyContact,
  isContactPageUrl,
  isSameHost,
  mergeContacts,
  type ExtractedContacts,
} from "@/lib/discovery/contact-extraction";
import { searchContactEvidence } from "@/lib/discovery/contact-search";
import { verifyInstagramProfile, type InstagramVerificationOutcome } from "@/lib/discovery/instagram-verification";

/**
 * Contact discovery — the fetching half.
 *
 * Discovery finds a business and its website, but a search result almost
 * never states an email or a phone number, so the prospect was saved with
 * neither even when the business publishes both on its own site. This reads
 * the site itself: the homepage, then the contact/about pages the homepage
 * links to, and extracts whatever those pages actually state.
 *
 * Deliberately no new provider. This is a plain HTTP GET of pages that are
 * already public, parsed deterministically (contact-extraction.ts) — no
 * search credits are spent, no model is asked to fill a gap, and every field
 * carries the URL it was read from, so a saved contact can always be checked
 * against its source.
 */

/** One page's worth of markup is plenty; anything larger is an asset, not a contact page. */
const MAX_BYTES = 1_500_000;
const PAGE_TIMEOUT_MS = 8_000;

/** Homepage plus at most this many internal contact/about pages. */
const MAX_INTERNAL_PAGES = 3;

/**
 * Whole-site budget. Enrichment runs inside the discovery request, which
 * already has its own ceiling — a slow or hanging site must cost a bounded
 * amount of that budget rather than the whole run.
 */
const SITE_BUDGET_MS = 20_000;

/**
 * Paths worth trying when the homepage links to no contact page at all.
 * Deliberately no "/connect" — real businesses run products literally named
 * "Connect" at that exact path (Zoho does), so guessing it wastes a page
 * budget slot on an unrelated page at best and misattributes a product page
 * as the contact page at worst, proven by a live run against zoho.com.
 */
const COMMON_CONTACT_PATHS = ["/contact", "/contact-us", "/contactus", "/about", "/about-us", "/company", "/get-in-touch", "/reach-us", "/support", "/team"];

const USER_AGENT = "BusinessBadhaoBot/1.0 (+contact discovery; respects robots meta)";

async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) return null;

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BYTES) return null;

  let html: string;
  try {
    html = await response.text();
  } catch {
    return null;
  }

  if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);

  return { html, finalUrl: response.url || url };
}

/** Normalizes whatever discovery stored as the website into a fetchable origin. */
export function toFetchableUrl(website: string | null): string | null {
  if (!website) return null;

  const trimmed = website.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Reads a prospect's own website for publicly listed contact channels.
 *
 * Returns null when there is no usable website, the site cannot be reached,
 * or nothing was found — never a partially invented result. A null here means
 * exactly "this site did not tell us", and the prospect is saved with
 * whatever discovery already had.
 */
export async function enrichProspectContact(website: string | null): Promise<ExtractedContacts | null> {
  const startedAt = Date.now();
  const homeUrl = toFetchableUrl(website);
  if (!homeUrl) return null;

  const home = await fetchPage(homeUrl);
  if (!home) return null;

  const homeContacts = extractContactsFromHtml(home.html, home.finalUrl);

  // Follow the site's own contact/about links first — that is where a
  // business puts the details it wants to be reached on — before falling back
  // to the conventional paths.
  const linkedPages = extractLinks(home.html, home.finalUrl)
    .filter(({ href, text }) => /^https?:/i.test(href) && isSameHost(href, home.finalUrl) && isContactPageUrl(href, text))
    .map(({ href }) => href.split("#")[0]);

  const fallbackPages = COMMON_CONTACT_PATHS.map((path) => {
    try {
      return new URL(path, home.finalUrl).toString();
    } catch {
      return null;
    }
  }).filter((url): url is string => Boolean(url));

  const seen = new Set([home.finalUrl.split("#")[0]]);
  const queue: string[] = [];
  for (const url of [...linkedPages, ...fallbackPages]) {
    if (seen.has(url)) continue;
    seen.add(url);
    queue.push(url);
    if (queue.length >= MAX_INTERNAL_PAGES) break;
  }

  const internalResults: ExtractedContacts[] = [];
  for (const url of queue) {
    if (Date.now() - startedAt > SITE_BUDGET_MS) break;
    const page = await fetchPage(url);
    if (!page) continue;
    internalResults.push(extractContactsFromHtml(page.html, page.finalUrl));
  }

  // Contact pages first: a number printed on /contact is the one the business
  // wants used, over whatever happened to appear in a homepage footer.
  const merged = mergeContacts([...internalResults, homeContacts]);

  return hasAnyContact(merged) ? merged : null;
}

export type ContactDiscoveryOutcome = {
  contacts: ExtractedContacts | null;
  /** "found" once anything real was found, from either stage; "not_found" when both stages genuinely ran and turned up nothing. */
  status: "found" | "not_found";
  /**
   * Whether the discovered Instagram handle (if any) was verified against
   * the org's own connected Instagram professional account — see
   * instagram-verification.ts. Always present (never undefined) so a
   * caller can tell "genuinely nothing to verify" from "verification
   * wasn't even attempted this call" (a website-less prospect, say).
   */
  instagram: InstagramVerificationOutcome;
};

/**
 * The full contact-discovery fallback chain: the business's own website
 * first (its own stated preference for how to be reached), then — only when
 * that produced nothing at all, including when there is no website to
 * fetch — bounded, targeted search evidence. A prospect discovered from a
 * directory or news listing with no domain ever mentioned is a normal,
 * common outcome of search-based discovery, not a failure of the website
 * crawler; without this second stage such a prospect could never gain a
 * contact by any path.
 *
 * Always returns a definite status rather than silence: "not_found" is
 * recorded explicitly (see mergeContactIntoRawData) precisely so a prospect
 * that was genuinely searched and came up empty is distinguishable from one
 * that was never attempted at all.
 */
/**
 * Best-effort, isolated Instagram verification for whatever contact block
 * this call ended up with. Never allowed to change the contact-discovery
 * outcome itself — a rate-limited or errored Business Discovery call still
 * returns real contact data, with Instagram's own outcome recorded
 * separately (see InstagramVerificationOutcome's own doc comment).
 */
async function verifyInstagramIfPresent(organizationId: string | undefined, contacts: ExtractedContacts): Promise<InstagramVerificationOutcome> {
  if (!organizationId || !contacts.instagram) return { attempted: false, reason: "no_handle" };

  try {
    return await verifyInstagramProfile(organizationId, contacts.instagram.value);
  } catch (error) {
    console.error("[contact-enrichment] Instagram verification threw unexpectedly — proceeding without it", error);
    return { attempted: true, ok: false, code: "provider_error", message: "Instagram verification failed unexpectedly." };
  }
}

export async function discoverProspectContacts(params: {
  companyName: string;
  website: string | null;
  location: string | null;
  telemetry?: ProviderTelemetry;
  /** Enables the Instagram Business Discovery verification step below — omit for a caller with no organization context. */
  organizationId?: string;
}): Promise<ContactDiscoveryOutcome> {
  const websiteContacts = await enrichProspectContact(params.website);
  if (websiteContacts && hasAnyContact(websiteContacts)) {
    const instagram = await verifyInstagramIfPresent(params.organizationId, websiteContacts);
    return { contacts: websiteContacts, status: "found", instagram };
  }

  const websiteHost = (() => {
    const url = toFetchableUrl(params.website);
    if (!url) return null;
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  })();

  const searchContacts = await searchContactEvidence({
    businessName: params.companyName,
    location: params.location,
    websiteHost,
    telemetry: params.telemetry,
  });

  const merged = mergeContacts([websiteContacts ?? emptyContacts(), searchContacts ?? emptyContacts()]);
  if (!hasAnyContact(merged)) return { contacts: null, status: "not_found", instagram: { attempted: false, reason: "no_handle" } };

  const instagram = await verifyInstagramIfPresent(params.organizationId, merged);
  return { contacts: merged, status: "found", instagram };
}

/**
 * Everything discovery already writes into prospects.raw_data, plus the
 * contact block. Kept as a merge helper so both discovery paths (the
 * interactive action and the scheduled pipeline) write exactly the same
 * shape.
 *
 * Always writes a contact block, even when nothing was found — a real,
 * recorded "not_found" is what tells the Lead page (and this deployment's
 * own audit trail) that enrichment genuinely ran and had nothing to report,
 * rather than never having been attempted.
 *
 * Per channel, an existing value is only replaced when the new one is
 * strictly stronger evidence (higher confidence) — never on a tie, never on
 * a downgrade. This only does real work on a re-run of an already-enriched
 * prospect (the manual "Find Contact Info" retry): a fresh prospect being
 * inserted for the first time has no existing contact block, so every field
 * here is simply new. Without this, a retry that fell back to weaker search
 * evidence — because the site happened to be briefly unreachable, say —
 * could silently replace a genuinely stronger, already-verified contact.
 */
const CONFIDENCE_RANK: Record<"high" | "medium" | "low", number> = { high: 3, medium: 2, low: 1 };

function strongerField<T extends { confidence: "high" | "medium" | "low" }>(existing: T | null | undefined, incoming: T | null | undefined): T | null {
  if (!incoming) return existing ?? null;
  if (!existing) return incoming;
  return CONFIDENCE_RANK[incoming.confidence] > CONFIDENCE_RANK[existing.confidence] ? incoming : existing;
}

export function mergeContactIntoRawData(base: Record<string, unknown>, outcome: ContactDiscoveryOutcome): Record<string, unknown> {
  const contacts = outcome.contacts;

  const existingContact =
    base.contact && typeof base.contact === "object" && !Array.isArray(base.contact) ? (base.contact as Record<string, unknown>) : null;
  const existing = (key: string) => (existingContact?.[key] as ExtractedContacts["email"] | undefined) ?? null;

  const merged = {
    email: strongerField(existing("email"), contacts?.email),
    phone: strongerField(existing("phone"), contacts?.phone),
    whatsapp: strongerField(existing("whatsapp"), contacts?.whatsapp),
    contactPageUrl: strongerField(existing("contactPageUrl"), contacts?.contactPageUrl),
    contactFormUrl: strongerField(existing("contactFormUrl"), contacts?.contactFormUrl),
    instagram: strongerField(existing("instagram"), contacts?.instagram),
    linkedin: strongerField(existing("linkedin"), contacts?.linkedin),
    facebook: strongerField(existing("facebook"), contacts?.facebook),
    address: strongerField(existing("address"), contacts?.address),
  };

  // The overall status reflects the merged result, not just this run's own
  // outcome: a re-run that found nothing new must never turn an already
  // "found" prospect back into "not_found" — the earlier evidence is still
  // real and still on file.
  const anyChannel = Object.values(merged).some((field) => field !== null);
  const status: "found" | "not_found" = anyChannel ? "found" : outcome.status;

  // Only a genuinely successful verification ever replaces what's already
  // on file — a retry that hit a rate limit or a since-broken connection
  // must never erase a profile a previous run already verified for real.
  const existingInstagramProfile =
    base.instagramProfile && typeof base.instagramProfile === "object" && !Array.isArray(base.instagramProfile)
      ? (base.instagramProfile as Record<string, unknown>)
      : null;
  const instagramProfile = outcome.instagram.attempted && outcome.instagram.ok
    ? { status: "verified" as const, ...outcome.instagram.profile, verifiedAt: new Date().toISOString() }
    : existingInstagramProfile ?? null;

  return {
    ...base,
    contact: { ...merged, contactStatus: status, enrichedAt: new Date().toISOString() },
    instagramProfile,
  };
}
