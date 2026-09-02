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

export type ContactField = {
  value: string;
  /** The page this value was actually read from. */
  source: string;
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

function isUsableEmail(email: string): boolean {
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

  const haystack = `${path} ${linkText}`.toLowerCase();
  return /contact|reach-us|reach_us|get-in-touch|about-us|about|enquiry|enquire|inquiry/.test(haystack);
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

  for (const { href, text } of links) {
    const lower = href.toLowerCase();

    if (!contacts.email && lower.startsWith("mailto:")) {
      const email = decodeEntities(href.slice("mailto:".length).split("?")[0].trim());
      if (email && isUsableEmail(email)) contacts.email = { value: email, source: pageUrl };
      continue;
    }

    if (!contacts.phone && lower.startsWith("tel:")) {
      const phone = href.slice("tel:".length).trim();
      const digits = normalizeDigits(phone);
      if (digits.length >= 8) contacts.phone = { value: phone, source: pageUrl };
      continue;
    }

    if (!contacts.whatsapp && /(?:wa\.me\/|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send|whatsapp:)/i.test(lower)) {
      contacts.whatsapp = { value: href, source: pageUrl };
      continue;
    }

    if (!contacts.instagram && /(?:^|\/\/|\.)instagram\.com\//i.test(lower) && !/instagram\.com\/(p|reel|explore)\//i.test(lower)) {
      contacts.instagram = { value: href, source: pageUrl };
      continue;
    }

    if (!contacts.linkedin && /(?:^|\/\/|\.)linkedin\.com\/(company|in|school)\//i.test(lower)) {
      contacts.linkedin = { value: href, source: pageUrl };
      continue;
    }

    if (
      !contacts.facebook &&
      /(?:^|\/\/|\.)(facebook\.com|fb\.com)\//i.test(lower) &&
      !/facebook\.com\/(sharer|share\.php|dialog)/i.test(lower)
    ) {
      contacts.facebook = { value: href, source: pageUrl };
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
      contacts.contactPageUrl = { value: href, source: pageUrl };
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
    const candidates = (visibleText.match(EMAIL_PATTERN) ?? []).map(decodeEntities).filter(isUsableEmail);
    if (candidates[0]) contacts.email = { value: candidates[0], source: pageUrl };
  }

  if (!contacts.phone) {
    const candidate = (visibleText.match(PHONE_PATTERN) ?? []).map((v) => v.trim()).find(looksLikePhoneNumber);
    if (candidate) contacts.phone = { value: candidate, source: pageUrl };
  }

  if (!contacts.address) {
    const address = extractJsonLdAddress(html);
    if (address) contacts.address = { value: address, source: pageUrl };
  }

  if (!contacts.contactFormUrl && hasContactForm(html)) {
    contacts.contactFormUrl = { value: pageUrl, source: pageUrl };
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
