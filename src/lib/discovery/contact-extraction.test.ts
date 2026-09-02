import { describe, expect, it } from "vitest";
import {
  emptyContacts,
  extractContactsFromHtml,
  extractJsonLdAddress,
  extractLinks,
  hasAnyContact,
  hasContactForm,
  isContactPageUrl,
  isSameHost,
  looksLikePhoneNumber,
  mergeContacts,
  normalizeDigits,
} from "@/lib/discovery/contact-extraction";

/**
 * Markup shaped like the real case this fixes: a small business site with a
 * Contact Us link, a phone number, Instagram and LinkedIn — everything the
 * lead page used to show as "—" because discovery only ever read search
 * result snippets, which state none of it.
 */
const AGENCY_HOME = `
<!doctype html><html><head><title>Inquisitive Digital</title></head>
<body>
  <nav><a href="/">Home</a><a href="/contact-us">Contact Us</a><a href="/about">About</a></nav>
  <footer>
    <a href="tel:+919876543210">+91 98765 43210</a>
    <a href="mailto:hello@inquisitivedigital.in">hello@inquisitivedigital.in</a>
    <a href="https://www.instagram.com/inquisitivedigital/">Instagram</a>
    <a href="https://www.linkedin.com/company/inquisitive-digital/">LinkedIn</a>
    <a href="https://www.facebook.com/inquisitivedigital">Facebook</a>
    <a href="https://wa.me/919876543210">WhatsApp us</a>
  </footer>
</body></html>`;

describe("extractContactsFromHtml", () => {
  const contacts = extractContactsFromHtml(AGENCY_HOME, "https://inquisitivedigital.in/");

  it("extracts the phone number the site actually links", () => {
    expect(contacts.phone?.value).toBe("+919876543210");
  });

  it("extracts the email the site actually links", () => {
    expect(contacts.email?.value).toBe("hello@inquisitivedigital.in");
  });

  it("extracts WhatsApp, Instagram, LinkedIn and Facebook", () => {
    expect(contacts.whatsapp?.value).toBe("https://wa.me/919876543210");
    expect(contacts.instagram?.value).toBe("https://www.instagram.com/inquisitivedigital/");
    expect(contacts.linkedin?.value).toBe("https://www.linkedin.com/company/inquisitive-digital/");
    expect(contacts.facebook?.value).toBe("https://www.facebook.com/inquisitivedigital");
  });

  it("finds the contact page and absolutizes it against the page it was linked from", () => {
    expect(contacts.contactPageUrl?.value).toBe("https://inquisitivedigital.in/contact-us");
  });

  it("records the page every value was read from — this is what makes a saved contact checkable", () => {
    expect(contacts.phone?.source).toBe("https://inquisitivedigital.in/");
    expect(contacts.email?.source).toBe("https://inquisitivedigital.in/");
    expect(contacts.instagram?.source).toBe("https://inquisitivedigital.in/");
  });

  it("finds nothing on a page that states nothing, rather than inventing a plausible contact", () => {
    const empty = extractContactsFromHtml("<html><body><h1>Coming soon</h1></body></html>", "https://example.in/");
    expect(hasAnyContact(empty)).toBe(false);
    expect(empty).toEqual(emptyContacts());
  });

  it("reads an email printed as plain text, not only one behind a mailto link", () => {
    const html = `<html><body><p>Write to us at studio@brightpixel.in for a quote.</p></body></html>`;
    expect(extractContactsFromHtml(html, "https://brightpixel.in/").email?.value).toBe("studio@brightpixel.in");
  });

  it("rejects addresses on RFC-reserved placeholder domains, which never reach a real business", () => {
    const html = `<html><body><p>Contact hello@example.com or hello@example.in</p></body></html>`;
    expect(extractContactsFromHtml(html, "https://brightpixel.in/").email).toBeNull();
  });

  it("ignores tooling and placeholder addresses that would never reach the business", () => {
    const html = `<html><body>
      <img src="logo@2x.png"><p>abc@sentry.wixpress.com</p><p>your@email.com</p>
    </body></html>`;
    expect(extractContactsFromHtml(html, "https://example.in/").email).toBeNull();
  });

  it("does not treat a share widget as the business's own Facebook page", () => {
    const html = `<html><body><a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a></body></html>`;
    expect(extractContactsFromHtml(html, "https://example.in/").facebook).toBeNull();
  });

  it("does not treat an Instagram post link as the business's profile", () => {
    const html = `<html><body><a href="https://www.instagram.com/p/Cabc123/">See post</a></body></html>`;
    expect(extractContactsFromHtml(html, "https://example.in/").instagram).toBeNull();
  });

  it("marks a page carrying a real enquiry form as a contact form", () => {
    const html = `<html><body><form action="/send"><input name="email"><textarea name="message"></textarea></form></body></html>`;
    const result = extractContactsFromHtml(html, "https://example.in/contact");
    expect(result.contactFormUrl?.value).toBe("https://example.in/contact");
  });

  it("does not report a site search box as a contact form", () => {
    const html = `<html><body><form><input type="search" name="q"></form></body></html>`;
    expect(extractContactsFromHtml(html, "https://example.in/").contactFormUrl).toBeNull();
  });

  it("takes an address only from structured data, never guessed out of prose", () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"LocalBusiness","name":"X","address":{"@type":"PostalAddress","streetAddress":"12 MG Road","addressLocality":"Bengaluru","postalCode":"560001"}}
    </script></head><body><p>Somewhere near the old bus stand, second floor</p></body></html>`;
    const result = extractContactsFromHtml(html, "https://example.in/");
    expect(result.address?.value).toBe("12 MG Road, Bengaluru, 560001");
  });

  it("leaves the address null when the page only describes its location in prose", () => {
    const html = `<html><body><p>Find us opposite the market, near the big banyan tree.</p></body></html>`;
    expect(extractContactsFromHtml(html, "https://example.in/").address).toBeNull();
  });
});

/**
 * Regressions found by running the real extractor against real business
 * websites (zoho.com, vercel.com, tavily.com). Each of these was returned as
 * a confident "contact" before the fix, which is exactly the kind of wrong
 * data that makes a lead list untrustworthy.
 */
describe("regressions from live sites", () => {
  it("does not merge digits from separate elements into a phone number", () => {
    // Real shape of a year list / company-size selector once tags are stripped.
    const html = `<html><body><ul><li>2026</li><li>2025</li><li>20</li></ul></body></html>`;
    expect(extractContactsFromHtml(html, "https://brightpixel.in/").phone).toBeNull();
  });

  it("does not read a form placeholder as the business's email address", () => {
    const html = `<html><body><form>
      <input type="email" name="email" placeholder="you@company.com">
      <textarea name="message"></textarea>
    </form></body></html>`;
    expect(extractContactsFromHtml(html, "https://brightpixel.in/contact").email).toBeNull();
  });

  it("does not treat a tracking parameter containing 'about' as a contact page", () => {
    const html = `<html><body><a href="https://brightpixel.in/backstage/?src=zoho-about-page">Backstage</a></body></html>`;
    expect(extractContactsFromHtml(html, "https://brightpixel.in/").contactPageUrl).toBeNull();
  });

  it("never records a third party's site as this business's contact page", () => {
    const html = `<html><body>
      <a href="https://www2.deloitte.com/in/en/pages/about-deloitte/awards.html">Award</a>
    </body></html>`;
    expect(extractContactsFromHtml(html, "https://brightpixel.in/").contactPageUrl).toBeNull();
  });

  it("does not record the page it is reading as its own contact page", () => {
    const html = `<html><body><a href="https://brightpixel.in/about">About</a></body></html>`;
    expect(extractContactsFromHtml(html, "https://brightpixel.in/about").contactPageUrl).toBeNull();
  });

  it("still finds a real contact page on the same site", () => {
    const html = `<html><body><a href="https://brightpixel.in/contact">Talk to us</a></body></html>`;
    expect(extractContactsFromHtml(html, "https://brightpixel.in/").contactPageUrl?.value).toBe("https://brightpixel.in/contact");
  });
});

describe("isSameHost", () => {
  it("treats www and bare hosts as the same site", () => {
    expect(isSameHost("https://www.brightpixel.in/a", "https://brightpixel.in/b")).toBe(true);
  });

  it("separates genuinely different sites", () => {
    expect(isSameHost("https://deloitte.com/a", "https://brightpixel.in/b")).toBe(false);
  });
});

describe("looksLikePhoneNumber", () => {
  it("rejects digits separated by a double space — the signature of two merged elements", () => {
    expect(looksLikePhoneNumber("2026    2025    20")).toBe(false);
    expect(looksLikePhoneNumber("1-20  21-100  101")).toBe(false);
  });

  it("accepts real Indian and international formats", () => {
    expect(looksLikePhoneNumber("+91 98765 43210")).toBe(true);
    expect(looksLikePhoneNumber("011-2345-6789")).toBe(true);
    expect(looksLikePhoneNumber("(022) 2654 3210")).toBe(true);
  });

  it("rejects years, prices and other short runs of digits", () => {
    expect(looksLikePhoneNumber("2024")).toBe(false);
    expect(looksLikePhoneNumber("1,299")).toBe(false);
  });

  it("rejects a run of digits too long to be a phone number", () => {
    expect(looksLikePhoneNumber("1234567890123456789")).toBe(false);
  });

  it("rejects placeholder numbers", () => {
    expect(looksLikePhoneNumber("0000000000")).toBe(false);
  });
});

describe("normalizeDigits", () => {
  it("makes two spellings of one number comparable", () => {
    expect(normalizeDigits("+91 98765-43210")).toBe(normalizeDigits("+919876543210"));
  });
});

describe("extractLinks", () => {
  it("absolutizes relative hrefs against the page they were found on", () => {
    const links = extractLinks(`<a href="/contact">Contact</a>`, "https://example.in/about");
    expect(links[0].href).toBe("https://example.in/contact");
  });

  it("keeps mailto and tel schemes intact rather than resolving them as paths", () => {
    const links = extractLinks(`<a href="mailto:a@b.in">Mail</a><a href="tel:+911234567890">Call</a>`, "https://example.in/");
    expect(links.map((l) => l.href)).toEqual(["mailto:a@b.in", "tel:+911234567890"]);
  });

  it("drops anchors and javascript: hrefs", () => {
    const links = extractLinks(`<a href="#top">Top</a><a href="javascript:void(0)">X</a>`, "https://example.in/");
    expect(links).toHaveLength(0);
  });
});

describe("isContactPageUrl", () => {
  it("recognises the usual contact and about paths", () => {
    expect(isContactPageUrl("https://x.in/contact-us")).toBe(true);
    expect(isContactPageUrl("https://x.in/about")).toBe(true);
    expect(isContactPageUrl("https://x.in/get-in-touch")).toBe(true);
  });

  it("recognises a contact page from its link text when the URL is opaque", () => {
    expect(isContactPageUrl("https://x.in/p/17", "Contact Us")).toBe(true);
  });

  it("does not treat an unrelated page as a contact page", () => {
    expect(isContactPageUrl("https://x.in/portfolio")).toBe(false);
  });
});

describe("hasContactForm", () => {
  it("is false for a page with no form at all", () => {
    expect(hasContactForm("<html><body><p>No form here</p></body></html>")).toBe(false);
  });
});

describe("extractJsonLdAddress", () => {
  it("ignores malformed JSON-LD instead of throwing", () => {
    expect(extractJsonLdAddress(`<script type="application/ld+json">{not json}</script>`)).toBeNull();
  });

  it("finds an address nested deeper in a graph", () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebSite"},{"@type":"LocalBusiness","address":{"streetAddress":"5 Park St","addressLocality":"Kolkata"}}]}
    </script>`;
    expect(extractJsonLdAddress(html)).toBe("5 Park St, Kolkata");
  });
});

describe("mergeContacts", () => {
  it("lets the earlier page win, so a value from /contact outranks a footer on the homepage", () => {
    const contactPage = { ...emptyContacts(), phone: { value: "+911111111111", source: "https://x.in/contact" } };
    const homepage = { ...emptyContacts(), phone: { value: "+912222222222", source: "https://x.in/" } };

    expect(mergeContacts([contactPage, homepage]).phone?.value).toBe("+911111111111");
  });

  it("fills a channel from a later page when the earlier one lacked it", () => {
    const contactPage = { ...emptyContacts(), phone: { value: "+911111111111", source: "https://x.in/contact" } };
    const homepage = { ...emptyContacts(), instagram: { value: "https://instagram.com/x", source: "https://x.in/" } };

    const merged = mergeContacts([contactPage, homepage]);
    expect(merged.phone?.value).toBe("+911111111111");
    expect(merged.instagram?.value).toBe("https://instagram.com/x");
  });
});
