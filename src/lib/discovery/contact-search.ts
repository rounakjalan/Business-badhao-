import "server-only";
import { searchWithFallback, type ProviderTelemetry, type SearchHit } from "@/lib/ai/agents/discovery";
import {
  emailConfidence,
  emptyContacts,
  findPhoneInText,
  findUsableEmailsInText,
  hasAnyContact,
  mergeContacts,
  urlMatchesBusinessName,
  type ExtractedContacts,
} from "@/lib/discovery/contact-extraction";

/**
 * Contact discovery's fallback stage — real search evidence, for the case
 * website crawling cannot cover at all: a prospect Lead Discovery found and
 * validated as a real business (it has a sourceUrl and evidenceSnippet
 * proving that) without ever capturing its website. That is a normal outcome
 * of search-based discovery, not a bug in it — a directory or news listing
 * can state a business exists without stating its domain — but it left the
 * website-only contact enrichment with nothing to fetch at all.
 *
 * Deliberately not a new AI call per prospect. Extraction here is the exact
 * same deterministic regex/pattern matching contact-extraction.ts applies to
 * fetched HTML, just applied to real Tavily/Exa result text instead — no
 * model is asked to fill the gap, so fabrication is prevented by
 * construction here too, not merely reviewed after the fact. Hermes and
 * Nemotron remain owned by discovery.ts's own job (finding and qualifying
 * the business); this module only ever reads what a real search actually
 * returned.
 */

/**
 * Hard cap on searches per prospect. The spec describes searching for email,
 * phone, contact page, WhatsApp, LinkedIn, Instagram and Facebook
 * separately — seven Tavily calls per prospect with no website, on every
 * hourly run, is not bounded cost on a free-tier deployment. One combined
 * query covers most of that in a single call; a second, narrower query only
 * fires if the first came back with nothing at all.
 */
const MAX_SEARCH_QUERIES = 2;

const SEARCH_BUDGET_MS = 15_000;

function buildQueries(businessName: string, location: string | null): string[] {
  const place = location ? ` ${location}` : "";
  return [`"${businessName}"${place} contact email phone`, `"${businessName}" official website contact us`];
}

/**
 * Whether this search result is actually about the prospect, not a
 * same-named but unrelated business. Domain match (when a website is known)
 * is the strongest signal; otherwise the result's own URL or title must
 * contain a distinctive fragment of the business name — never accepted on
 * the strength of a snippet merely mentioning the name near an unrelated link.
 */
function resultLooksRelevant(hit: SearchHit, businessName: string, websiteHost: string | null): boolean {
  if (websiteHost) {
    try {
      if (new URL(hit.url).hostname.replace(/^www\./, "") === websiteHost.replace(/^www\./, "")) return true;
    } catch {
      // fall through to name matching
    }
  }
  return urlMatchesBusinessName(hit.url, businessName) || urlMatchesBusinessName(hit.title, businessName);
}

function extractFromSearchHit(hit: SearchHit, businessName: string, websiteHost: string | null): ExtractedContacts {
  const contacts = emptyContacts();
  if (!resultLooksRelevant(hit, businessName, websiteHost)) return contacts;

  const lower = hit.url.toLowerCase();
  const text = `${hit.title} ${hit.content}`;

  if (/(?:^|\/\/|\.)instagram\.com\//i.test(lower) && !/instagram\.com\/(p|reel|explore)\//i.test(lower)) {
    contacts.instagram = { value: hit.url, source: hit.url, confidence: "medium" };
  } else if (/(?:^|\/\/|\.)linkedin\.com\/(company|in|school)\//i.test(lower)) {
    contacts.linkedin = { value: hit.url, source: hit.url, confidence: "medium" };
  } else if (
    /(?:^|\/\/|\.)(facebook\.com|fb\.com)\//i.test(lower) &&
    !/facebook\.com\/(sharer|share\.php|dialog)/i.test(lower)
  ) {
    contacts.facebook = { value: hit.url, source: hit.url, confidence: "medium" };
  }

  const emails = findUsableEmailsInText(text);
  if (emails[0]) contacts.email = { value: emails[0], source: hit.url, confidence: emailConfidence(emails[0], websiteHost) };

  const phone = findPhoneInText(text);
  if (phone) contacts.phone = { value: phone, source: hit.url, confidence: "medium" };

  return contacts;
}

/**
 * Runs at most two bounded, targeted searches for a business's contact
 * details and extracts only what the real results actually state. Returns
 * null when nothing relevant and usable was found — the caller decides how
 * to record that, this module never claims success it does not have.
 */
export async function searchContactEvidence(params: {
  businessName: string;
  location: string | null;
  websiteHost: string | null;
  telemetry?: ProviderTelemetry;
}): Promise<ExtractedContacts | null> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  const exaApiKey = process.env.EXA_API_KEY;

  const startedAt = Date.now();
  const queries = buildQueries(params.businessName, params.location).slice(0, MAX_SEARCH_QUERIES);
  const results: ExtractedContacts[] = [];

  for (const query of queries) {
    if (Date.now() - startedAt > SEARCH_BUDGET_MS) break;

    const searchResult = await searchWithFallback(query, apiKey, exaApiKey, params.telemetry);
    if (!searchResult.ok) continue;

    const extracted = searchResult.results.map((hit) => extractFromSearchHit(hit, params.businessName, params.websiteHost));
    const merged = mergeContacts(extracted);
    results.push(merged);

    // The combined first query is deliberately tried first; if it already
    // found something real, the second, narrower query would only spend
    // budget re-finding the same evidence.
    if (hasAnyContact(merged)) break;
  }

  const merged = mergeContacts(results);
  return hasAnyContact(merged) ? merged : null;
}
