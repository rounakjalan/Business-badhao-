/**
 * Contact extraction — the pure half of contact discovery.
 *
 * Every value this module returns is copied verbatim out of HTML that was
 * actually retrieved from a real page, and is returned together with the URL
 * it came from. Nothing is inferred, completed, or guessed: there is no model
 * in this path at all, which is what makes fabrication impossible here rather
 * than merely discouraged. A business with no phone number on its site comes
 * back with no phone number.
 *
 * The fetching half lives in contact-enrichment.ts; keeping the parsing
 * separate is what lets it be tested against real page markup without network
 * access.
 */

/**
 * How sure we are this value actually belongs to the prospect, not just that
 * it passed the anti-fabrication filters. Never affects whether a value is
 * stored — a low-confidence value found on a real page is still real
 * evidence, just weaker evidence — only how it should be presented.
 */
export type ContactConfidence = "high" | "medium" | "low";

export type ContactField = {
  value: string;
  /** The page this value was actually read from. */
  source: string;
  confidence: ContactConfidence;
};

export type ExtractedContacts = {
  email: ContactField | null;
  phone: ContactField | null;
  whatsapp: ContactField | null;
  contactPageUrl: ContactField | null;
  contactFormUrl: ContactField | null;
  instagram: ContactField | null;
  linkedin: ContactField | null;
  facebook: ContactField | null;
  address: ContactField | null;
};

export function emptyContacts(): ExtractedContacts {
  return {
    email: null,
    phone: null,
    whatsapp: null,
    contactPageUrl: null,
    contactFormUrl: null,
    instagram: null,
    linkedin: null,
    facebook: null,
    address: null,
  };
}

/**
 * Addresses that exist on a page but belong to the website's tooling rather
 * than the business — sending outreach to one of these reaches a hosting
 * provider or an image CDN, never the prospect.
 */
const NON_BUSINESS_EMAIL_PATTERN =
  /@(example\.|sentry\.|wixpress\.|sentry-cdn|godaddy\.|squarespace\.|shopify\.|wordpress\.|cloudflare\.|googlemail\.com$|domain\.com$|email\.com$|yourdomain)/i;

/**
 * Form placeholders, not contacts. Real sites seed their enquiry forms with
 * example addresses — a live run against real business sites returned
 * "you@company.com" and "tammytriangle@yourcompany.com", and saving either
 * would have meant outreach to an address that does not exist.
 */
const PLACEHOLDER_EMAIL_PATTERN =
  /^(your|you|email|name|user|test|info@example|someone|username|firstname|john|jane)@|@(yourcompany|your-company|company\.com|acme)/i;

/** Image and asset filenames routinely match a naive email regex ("logo@2x.png"). */
const ASSET_LIKE_EMAIL_PATTERN = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ico)$/i;

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Sites routinely spell an email out to defeat scrapers: "hello [at] brand
 * [dot] com" or "hello(at)brand(dot)co(dot)in". This is still the business's
 * own real address, printed by the business itself — normalizing it is not
 * inference, the way guessing a Gmail from the company name would be.
 */
const OBFUSCATED_EMAIL_PATTERN =
  /([a-zA-Z0-9._%+-]+)\s*[[(]\s*at\s*[\])]\s*([a-zA-Z0-9.-]+(?:\s*[[(]\s*dot\s*[\])]\s*[a-zA-Z0-9-]+)+)/gi;

/** Turns "brand [dot] co [dot] in" into "brand.co.in". */
function normalizeObfuscatedDomain(raw: string): string {
  return raw.replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".").trim();
}

/** Free webmail providers, common in India and worldwide — never rejected, never boosted either. */
const FREE_EMAIL_PROVIDERS = new Set([
  "gmail.com",
  "yahoo.com",
  "yahoo.co.in",
  "outlook.com",
  "hotmail.com",
  "rediffmail.com",
  "icloud.com",
  "protonmail.com",
]);

/** The registrable part of a hostname, stripping a leading "www." — good enough for same-business comparison without a public-suffix list. */
function registrableHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * How much an email's domain says about whether it actually belongs to this
 * prospect. Matches the exact business rule requested: a domain-matched
 * business email is high confidence; a free provider is never auto-rejected,
 * but only reaches medium when it was actually found published on the
 * business's own official page (the caller passes null siteHost when the
 * email came from somewhere else, e.g. a search snippet with no page of its
 * own to anchor it to).
 */
export function emailConfidence(email: string, siteHost: string | null): ContactConfidence {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return "low";

  if (siteHost && registrableHost(domain) === registrableHost(siteHost)) return "high";
  if (FREE_EMAIL_PROVIDERS.has(domain) && siteHost) return "medium";
  if (FREE_EMAIL_PROVIDERS.has(domain)) return "low";
  return siteHost ? "medium" : "low";
}

/**
 * Phone numbers as they appear in real markup: an optional country code, then
 * 8–14 digits with spaces, dashes, dots or brackets between them. Deliberately
 * strict about length at both ends — shorter matches are almost always prices,
 * dates or PIN codes, and longer ones are tracking ids.
 */
const PHONE_PATTERN = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)[\s.-]?)?\d[\d\s.-]{7,16}\d/g;

/** Strips every separator so two spellings of one number compare equal. */
export function normalizeDigits(raw: string): string {
  return raw.replace(/[^\d+]/g, "");
}

/**
 * Whether a candidate string is plausibly a real phone number rather than a
 * year, a price, a postcode, or an id that happened to sit in a tel-shaped
 * run of digits. Applied to every free-text match; numbers taken from an
 * explicit `tel:` link skip it, since the page has already declared what they
 * are.
 */
export function looksLikePhoneNumber(raw: string): boolean {
  // Runs of digits from *separate* page elements collapse into one candidate
  // once tags are stripped — a live run produced "2026    2025    20" from a
  // list of years and "1-20  21-100  101" from a company-size selector. Real
  // phone formatting never uses a double space, so this is what separates a
  // written number from two numbers that merely ended up adjacent.
  if (/\s{2,}/.test(raw)) return false;

  const digits = normalizeDigits(raw).replace(/^\+/, "");
  if (digits.length < 8 || digits.length > 15) return false;

  // A single repeated digit (00000000, 11111111) is a placeholder, never a number.
  if (/^(\d)\1+$/.test(digits)) return false;

  return true;
}

/** Decodes the handful of HTML entities that actually appear inside href attributes. */
function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&#64;/g, "@").replace(/&#46;/g, ".").replace(/&quot;/g, '"');
}

/** Every href on the page, absolutized against the page's own URL. */
export function extractLinks(html: string, pageUrl: string): { href: string; text: string }[] {
  const links: { href: string; text: string }[] = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const rawHref = decodeEntities(match[1].trim());
    const text = match[2]
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const absolute = absolutize(rawHref, pageUrl);
    if (absolute) links.push({ href: absolute, text });
  }

  return links;
}

/**
 * Resolves an href against the page it appeared on. Non-navigational schemes
 * (mailto:, tel:, whatsapp:) are returned untouched so the caller can read
 * them; anything unresolvable returns null rather than a constructed guess.
 */
export function absolutize(href: string, pageUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || /^javascript:/i.test(trimmed)) return null;
  if (/^(mailto:|tel:|whatsapp:|sms:)/i.test(trimmed)) return trimmed;

  try {
    return new URL(trimmed, pageUrl).toString();
  } catch {
    return null;
  }
}

export function isUsableEmail(email: string): boolean {
  if (ASSET_LIKE_EMAIL_PATTERN.test(email)) return false;
  if (NON_BUSINESS_EMAIL_PATTERN.test(email)) return false;
  if (PLACEHOLDER_EMAIL_PATTERN.test(email)) return false;
  return true;
}

/**
 * Pulls a postal address out of schema.org JSON-LD, the one place a page
 * states its address as structured data rather than as prose. Prose addresses
 * are deliberately not parsed: picking the right lines out of free text is
 * guesswork, and a wrong address is worse than none.
 */
export function extractJsonLdAddress(html: string): string | null {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi);
  if (!blocks) return null;

  for (const block of blocks) {
    const jsonText = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      continue;
    }

    const address = findPostalAddress(parsed);
    if (address) return address;
  }

  return null;
}

function findPostalAddress(node: unknown, depth = 0): string | null {
  if (depth > 6 || !node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPostalAddress(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = node as Record<string, unknown>;
  const address = record.address;

  if (typeof address === "string" && address.trim()) return address.trim();

  if (address && typeof address === "object" && !Array.isArray(address)) {
    const parts = ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"]
      .map((key) => (address as Record<string, unknown>)[key])
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);

    if (parts.length > 0) return parts.join(", ");
  }

  for (const value of Object.values(record)) {
    const found = findPostalAddress(value, depth + 1);
    if (found) return found;
  }

  return null;
}

/** Whether two URLs sit on the same site, ignoring a leading "www.". */
export function isSameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

/** Whether a URL looks like a contact/about page worth following from the homepage. */
export function isContactPageUrl(url: string, linkText = ""): boolean {
  // Only the path is examined, never the query string: a live run matched
  // "/backstage/?src=zoho-about-page" as a contact page purely because its
  // tracking parameter contained the word "about".
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not an absolute URL — fall back to matching the raw value, minus any query.
    path = url.split("?")[0];
  }

  // "connect" is never matched at all, neither in the URL path nor the link
  // text. Real businesses run actual products called "Connect" (Zoho does,
  // at the literal path "/connect") — a live run against zoho.com wrongly
  // matched it as a contact page twice: first via a sub-page's URL, then via
  // the product's own root URL once the URL match was tightened, then via
  // the link's own visible text ("Connect") once path-matching was dropped
  // entirely. Three proven false positives against one real, major site is
  // conclusive: the word is too overloaded to be a safe signal in any form,
  // and a wrongly attributed contact page is exactly the failure this
  // extractor exists to prevent.
  const haystack = `${path} ${linkText}`.toLowerCase();
  return /contact|reach-?us|get-?in-?touch|talk-?to-?us|about-?us|about|company|enquiry|enquire|inquiry|support|our-?team\b|\bteam\b/.test(haystack);
}

/** Extracts the digits WhatsApp itself encodes in a wa.me / api.whatsapp.com link, when present. */
export function extractWhatsappNumber(href: string): string | null {
  const match = href.match(/(?:wa\.me\/|phone=)(\+?\d[\d\s-]{6,})/i);
  if (!match) return null;
  const digits = normalizeDigits(match[1]);
  return digits.length >= 8 ? digits : null;
}

/**
 * Every usable email address in a run of plain text — shared by the HTML
 * extractor and the search-result extractor (contact-search.ts) so both
 * apply exactly the same anti-fabrication filters, not two copies that could
 * drift apart.
 */
export function findUsableEmailsInText(text: string): string[] {
  return (text.match(EMAIL_PATTERN) ?? []).map(decodeEntities).filter(isUsableEmail);
}

/** The first plausible phone number in a run of plain text, or null. */
export function findPhoneInText(text: string): string | null {
  return (text.match(PHONE_PATTERN) ?? []).map((v) => v.trim()).find(looksLikePhoneNumber) ?? null;
}

/** Whether a page actually contains a form a visitor could submit. */
export function hasContactForm(html: string): boolean {
  if (!/<form\b/i.test(html)) return false;
  // A lone search box is not a contact form.
  const formBlocks = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  return formBlocks.some((form) => {
    if (/type\s*=\s*["']?search/i.test(form) && !/textarea/i.test(form)) return false;
    return /textarea|type\s*=\s*["']?email|name\s*=\s*["'](email|message|phone|name)/i.test(form);
  });
}

/**
 * Extracts every contact channel this one page actually states.
 *
 * Explicit links (`mailto:`, `tel:`, wa.me, social profiles) are trusted over
 * free text, because the page has declared what they are. Free-text scanning
 * is the fallback for sites that print an address or number without linking
 * it, and is filtered hard (see looksLikePhoneNumber / isUsableEmail) rather
 * than accepted optimistically.
 */
export function extractContactsFromHtml(html: string, pageUrl: string): ExtractedContacts {
  const contacts = emptyContacts();
  const links = extractLinks(html, pageUrl);
  const siteHost = (() => {
    try {
      return new URL(pageUrl).hostname;
    } catch {
      return null;
    }
  })();

  for (const { href, text } of links) {
    const lower = href.toLowerCase();

    if (!contacts.email && lower.startsWith("mailto:")) {
      const email = decodeEntities(href.slice("mailto:".length).split("?")[0].trim());
      if (email && isUsableEmail(email)) contacts.email = { value: email, source: pageUrl, confidence: emailConfidence(email, siteHost) };
      continue;
    }

    if (!contacts.phone && lower.startsWith("tel:")) {
      const phone = href.slice("tel:".length).trim();
      const digits = normalizeDigits(phone);
      if (digits.length >= 8) contacts.phone = { value: phone, source: pageUrl, confidence: "high" };
      continue;
    }

    if (!contacts.whatsapp && /(?:wa\.me\/|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send|whatsapp:)/i.test(lower)) {
      // The link itself declares the number where it can — that is direct
      // evidence, not an inference, so this keeps high confidence even
      // though the stored value is now the number rather than the URL.
      const number = extractWhatsappNumber(href);
      contacts.whatsapp = { value: number ?? href, source: pageUrl, confidence: "high" };
      continue;
    }

    if (!contacts.instagram && /(?:^|\/\/|\.)instagram\.com\//i.test(lower) && !/instagram\.com\/(p|reel|explore)\//i.test(lower)) {
      contacts.instagram = { value: href, source: pageUrl, confidence: "high" };
      continue;
    }

    if (!contacts.linkedin && /(?:^|\/\/|\.)linkedin\.com\/(company|in|school)\//i.test(lower)) {
      contacts.linkedin = { value: href, source: pageUrl, confidence: "high" };
      continue;
    }

    if (
      !contacts.facebook &&
      /(?:^|\/\/|\.)(facebook\.com|fb\.com)\//i.test(lower) &&
      !/facebook\.com\/(sharer|share\.php|dialog)/i.test(lower)
    ) {
      contacts.facebook = { value: href, source: pageUrl, confidence: "high" };
      continue;
    }

    // The business's contact page must be on the business's own site, and a
    // page linking to itself is not a contact page it can point anyone to. A
    // live run against a real site otherwise recorded a third party's
    // "/pages/about-deloitte/..." award page as the prospect's contact page.
    if (
      !contacts.contactPageUrl &&
      /^https?:/i.test(href) &&
      href.split("#")[0] !== pageUrl.split("#")[0] &&
      isSameHost(href, pageUrl) &&
      isContactPageUrl(href, text)
    ) {
      contacts.contactPageUrl = { value: href, source: pageUrl, confidence: "high" };
    }
  }

  // Free-text fallbacks, only for channels no explicit link already supplied.
  //
  // Tags are replaced with newlines rather than spaces, and attributes go with
  // them: text from two separate elements must not merge into one candidate
  // (that is what produced a "phone number" made of three adjacent years in a
  // live run), and attribute values are where form placeholders live.
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<[^>]*>/g, "\n");

  if (!contacts.email) {
    const candidates = findUsableEmailsInText(visibleText);
    if (candidates[0]) contacts.email = { value: candidates[0], source: pageUrl, confidence: emailConfidence(candidates[0], siteHost) };
  }

  // Obfuscated form ("hello [at] brand [dot] com") only checked when a plain
  // "@" address wasn't already found — sites use one style or the other, not
  // both for the same address.
  if (!contacts.email) {
    const match = OBFUSCATED_EMAIL_PATTERN.exec(visibleText);
    OBFUSCATED_EMAIL_PATTERN.lastIndex = 0;
    if (match) {
      const candidate = `${match[1]}@${normalizeObfuscatedDomain(match[2])}`;
      if (isUsableEmail(candidate)) contacts.email = { value: candidate, source: pageUrl, confidence: emailConfidence(candidate, siteHost) };
    }
  }

  if (!contacts.phone) {
    const candidate = findPhoneInText(visibleText);
    if (candidate) contacts.phone = { value: candidate, source: pageUrl, confidence: "medium" };
  }

  if (!contacts.address) {
    const address = extractJsonLdAddress(html);
    if (address) contacts.address = { value: address, source: pageUrl, confidence: "high" };
  }

  if (!contacts.contactFormUrl && hasContactForm(html)) {
    contacts.contactFormUrl = { value: pageUrl, source: pageUrl, confidence: "high" };
  }

  return contacts;
}

/**
 * Merges contacts found on several pages of one site, first-found winning.
 * Pages are passed in priority order by the caller (the site's own contact
 * page before its homepage, for instance), so this never has to decide which
 * of two conflicting values is more trustworthy — the caller's ordering does.
 */
export function mergeContacts(results: ExtractedContacts[]): ExtractedContacts {
  const merged = emptyContacts();

  for (const result of results) {
    for (const key of Object.keys(merged) as (keyof ExtractedContacts)[]) {
      if (!merged[key] && result[key]) merged[key] = result[key];
    }
  }

  return merged;
}

/** Whether anything at all was found — used to decide if a lead is contactable. */
export function hasAnyContact(contacts: ExtractedContacts): boolean {
  return Object.values(contacts).some((field) => field !== null);
}

/**
 * Distinctive words from a business name — short/common words ("the", "and",
 * "llp") are dropped because they would match almost any URL, which is
 * exactly the false "proof" the anti-fabrication requirement rules out.
 */
export function nameTokens(businessName: string): string[] {
  const STOPWORDS = new Set(["the", "and", "llp", "pvt", "ltd", "inc", "co", "company", "india", "services", "solutions"]);
  return businessName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * Whether a URL contains real, checkable evidence that it belongs to this
 * business — a distinctive name token actually present in the URL itself,
 * not merely mentioned somewhere in a search snippet next to an unrelated
 * link. This is the bar for accepting a social profile or page found via
 * search rather than found linked from the business's own website.
 */
export function urlMatchesBusinessName(url: string, businessName: string): boolean {
  const tokens = nameTokens(businessName);
  if (tokens.length === 0) return false;

  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const normalizedPath = path.replace(/[^a-z0-9]+/g, "");

  return tokens.some((token) => normalizedPath.includes(token));
}
