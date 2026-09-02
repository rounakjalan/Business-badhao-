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
export async function discoverProspectContacts(params: {
  companyName: string;
  website: string | null;
  location: string | null;
  telemetry?: ProviderTelemetry;
}): Promise<ContactDiscoveryOutcome> {
  const websiteContacts = await enrichProspectContact(params.website);
  if (websiteContacts && hasAnyContact(websiteContacts)) {
    return { contacts: websiteContacts, status: "found" };
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
  return hasAnyContact(merged) ? { contacts: merged, status: "found" } : { contacts: null, status: "not_found" };
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
 */
export function mergeContactIntoRawData(base: Record<string, unknown>, outcome: ContactDiscoveryOutcome): Record<string, unknown> {
  const contacts = outcome.contacts;

  return {
    ...base,
    contact: {
      email: contacts?.email ?? null,
      phone: contacts?.phone ?? null,
      whatsapp: contacts?.whatsapp ?? null,
      contactPageUrl: contacts?.contactPageUrl ?? null,
      contactFormUrl: contacts?.contactFormUrl ?? null,
      instagram: contacts?.instagram ?? null,
      linkedin: contacts?.linkedin ?? null,
      facebook: contacts?.facebook ?? null,
      address: contacts?.address ?? null,
      contactStatus: outcome.status,
      enrichedAt: new Date().toISOString(),
    },
  };
}
