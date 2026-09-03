import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverProspectContacts, enrichProspectContact, mergeContactIntoRawData, toFetchableUrl } from "@/lib/discovery/contact-enrichment";
import { emptyContacts } from "@/lib/discovery/contact-extraction";

/**
 * discoverProspectContacts is the fix for the exact production bug reported:
 * "Triverse" and "D S Media Link" both have website: null in production, and
 * the old enrichProspectContact was 100% website-fetch-dependent — a null
 * website meant contact enrichment was never even attempted. These tests
 * prove the fallback chain actually closes that gap, not just that the
 * individual pieces exist.
 */

function htmlResponse(html: string) {
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
}

function mockFetchRouter(handlers: { website?: (url: string) => Response | Promise<Response>; tavily?: (query: string) => Response | Promise<Response> }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://api.tavily.com/search") {
      if (!handlers.tavily) throw new Error("unexpected Tavily call in this test");
      const body = JSON.parse(String(init?.body ?? "{}"));
      return handlers.tavily(body.query);
    }
    if (!handlers.website) throw new Error(`unexpected website fetch in this test: ${url}`);
    return handlers.website(url);
  });
}

describe("discoverProspectContacts", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, TAVILY_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it("THE PRODUCTION BUG: a prospect with website: null now gets a real contact via search fallback, instead of never being attempted at all", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchRouter({
        tavily: (query) => {
          if (query.includes("Triverse")) {
            return new Response(
              JSON.stringify({ results: [{ title: "Triverse Studio", url: "https://triverse.studio/contact", content: "Reach us at hello@triverse.studio or call +91 98765 43210." }] }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        },
      })
    );

    const outcome = await discoverProspectContacts({ companyName: "Triverse", website: null, location: "Pune" });

    expect(outcome.status).toBe("found");
    expect(outcome.contacts?.email?.value).toBe("hello@triverse.studio");
    expect(outcome.contacts?.phone?.value).toBe("+91 98765 43210");
  });

  it("prefers the website stage over search when the website alone already has real contact info", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchRouter({
        website: () => htmlResponse(`<html><body><a href="mailto:hello@brightpixel.in">Email</a></body></html>`),
        tavily: () => {
          throw new Error("must not call search when the website already found something");
        },
      })
    );

    const outcome = await discoverProspectContacts({ companyName: "Bright Pixel", website: "brightpixel.in", location: "Delhi" });
    expect(outcome.status).toBe("found");
    expect(outcome.contacts?.email?.value).toBe("hello@brightpixel.in");
  });

  it("falls back to search when the website exists but genuinely states no contact info", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchRouter({
        website: () => htmlResponse(`<html><body><h1>Coming soon</h1></body></html>`),
        tavily: () =>
          new Response(JSON.stringify({ results: [{ title: "Bright Pixel Studio", url: "https://brightpixel.in/about", content: "Contact hello@brightpixel.in" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      })
    );

    const outcome = await discoverProspectContacts({ companyName: "Bright Pixel", website: "brightpixel.in", location: "Delhi" });
    expect(outcome.status).toBe("found");
    expect(outcome.contacts?.email?.value).toBe("hello@brightpixel.in");
  });

  it("records contact_status: not_found — an honest completed search, never silence and never a fabrication — when nothing real exists anywhere", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchRouter({
        website: () => htmlResponse(`<html><body><h1>Coming soon</h1></body></html>`),
        tavily: () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      })
    );

    const outcome = await discoverProspectContacts({ companyName: "Ghost Business", website: "ghostbusiness.in", location: "Delhi" });
    expect(outcome.status).toBe("not_found");
    expect(outcome.contacts).toBeNull();
  });

  it("still records a definite not_found status (not silence) for a prospect with no website at all and no search evidence", async () => {
    vi.stubGlobal("fetch", mockFetchRouter({ tavily: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) }));

    const outcome = await discoverProspectContacts({ companyName: "Unfindable Co", website: null, location: null });
    expect(outcome.status).toBe("not_found");
  });
});

describe("mergeContactIntoRawData", () => {
  it("always writes a contact block with contactStatus, even on a not_found outcome — distinguishing 'searched, found nothing' from 'never attempted'", () => {
    const result = mergeContactIntoRawData({ location: "Pune" }, { contacts: null, status: "not_found" });
    expect(result.contact).toMatchObject({ contactStatus: "not_found", email: null, phone: null });
    expect(result.location).toBe("Pune");
  });

  it("preserves every other raw_data field untouched", () => {
    const result = mergeContactIntoRawData({ location: "Pune", industry: "Retail", evidenceSnippet: "a real snippet" }, { contacts: null, status: "not_found" });
    expect(result.industry).toBe("Retail");
    expect(result.evidenceSnippet).toBe("a real snippet");
  });

  it("never overwrites an existing high-confidence contact with a weaker retry result", () => {
    const base = { contact: { email: { value: "hello@brightpixel.in", source: "https://brightpixel.in/contact", confidence: "high" } } };
    const retry = {
      contacts: { ...emptyContacts(), email: { value: "brightpixel.studio@gmail.com", source: "https://directory.example/listing", confidence: "low" as const } },
      status: "found" as const,
    };

    const result = mergeContactIntoRawData(base, retry);
    expect((result.contact as { email: { value: string } }).email.value).toBe("hello@brightpixel.in");
  });

  it("upgrades an existing low-confidence contact when a retry finds genuinely stronger evidence", () => {
    const base = { contact: { email: { value: "brightpixel.studio@gmail.com", source: "https://directory.example/listing", confidence: "low" } } };
    const retry = {
      contacts: { ...emptyContacts(), email: { value: "hello@brightpixel.in", source: "https://brightpixel.in/contact", confidence: "high" as const } },
      status: "found" as const,
    };

    const result = mergeContactIntoRawData(base, retry);
    expect((result.contact as { email: { value: string } }).email.value).toBe("hello@brightpixel.in");
  });

  it("keeps the existing value on a same-confidence tie rather than churning on every retry", () => {
    const base = { contact: { phone: { value: "+91 98765 43210", source: "https://brightpixel.in/contact", confidence: "high" } } };
    const retry = {
      contacts: { ...emptyContacts(), phone: { value: "+91 11111 11111", source: "https://brightpixel.in/about", confidence: "high" as const } },
      status: "found" as const,
    };

    const result = mergeContactIntoRawData(base, retry);
    expect((result.contact as { phone: { value: string } }).phone.value).toBe("+91 98765 43210");
  });

  it("fills in a channel the retry found that the original enrichment never had, without touching the channel it already had", () => {
    const base = { contact: { email: { value: "hello@brightpixel.in", source: "https://brightpixel.in/contact", confidence: "high" } } };
    const retry = {
      contacts: { ...emptyContacts(), linkedin: { value: "https://linkedin.com/company/brightpixel", source: "https://brightpixel.in/about", confidence: "high" as const } },
      status: "found" as const,
    };

    const result = mergeContactIntoRawData(base, retry) as { contact: { email: { value: string }; linkedin: { value: string } } };
    expect(result.contact.email.value).toBe("hello@brightpixel.in");
    expect(result.contact.linkedin.value).toBe("https://linkedin.com/company/brightpixel");
  });

  it("never downgrades an already-found prospect back to not_found when a retry turns up nothing new", () => {
    const base = { contact: { email: { value: "hello@brightpixel.in", source: "https://brightpixel.in/contact", confidence: "high" } } };
    const retry = { contacts: null, status: "not_found" as const };

    const result = mergeContactIntoRawData(base, retry);
    expect((result.contact as { contactStatus: string }).contactStatus).toBe("found");
  });

  it("has no existing contact to protect on a fresh prospect's first insert — the new outcome is simply written through", () => {
    const result = mergeContactIntoRawData(
      { location: "Pune" },
      { contacts: { ...emptyContacts(), email: { value: "hello@brightpixel.in", source: "https://brightpixel.in/contact", confidence: "high" } }, status: "found" }
    );
    expect((result.contact as { email: { value: string } }).email.value).toBe("hello@brightpixel.in");
  });
});

describe("enrichProspectContact / toFetchableUrl (website stage, unchanged behavior)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null immediately for a null website — never attempts a fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await enrichProspectContact(null);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades gracefully — returns null, never throws — when the site is unreachable (simulated timeout/network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network timeout");
      })
    );
    const result = await enrichProspectContact("unreachable-site.example");
    expect(result).toBeNull();
  });

  it("degrades gracefully when the site returns a real HTTP error (broken contact page / whole site down)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
    const result = await enrichProspectContact("brokensite.example");
    expect(result).toBeNull();
  });

  it("normalizes a bare domain into a fetchable https URL", () => {
    expect(toFetchableUrl("brightpixel.in")).toBe("https://brightpixel.in/");
    expect(toFetchableUrl("https://brightpixel.in")).toBe("https://brightpixel.in/");
  });

  it("rejects an unusable website value rather than attempting a malformed fetch", () => {
    expect(toFetchableUrl(null)).toBeNull();
    expect(toFetchableUrl("")).toBeNull();
    expect(toFetchableUrl("not a url at all")).toBeNull();
  });
});
